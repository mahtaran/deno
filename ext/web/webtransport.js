// Copyright 2018-2024 the Deno authors. All rights reserved. MIT license.
import { primordials } from "ext:core/mod.js";
import * as webidl from "ext:deno_webidl/00_webidl.js";
import {
  connectQuic,
  webtransportAccept,
  webtransportConnect,
} from "ext:deno_net/03_quic.js";
import { assert } from "./00_infra.js";
import { DOMException } from "./01_dom_exception.js";
import {
  getReadableStreamResourceBacking,
  getWritableStreamResourceBacking,
  ReadableStream,
  readableStreamForRid,
  WritableStream,
  WritableStreamDefaultWriter,
  writableStreamForRid,
} from "./06_streams.js";
import { getLocationHref } from "./12_location.js";

const {
  ArrayBufferPrototype,
  ArrayBufferIsView,
  ArrayPrototypeShift,
  ArrayPrototypePush,
  DataView,
  DataViewPrototype,
  DataViewPrototypeSetUint16,
  DataViewPrototypeSetUint32,
  DataViewPrototypeSetBigUint64,
  DateNow,
  BigInt,
  Number,
  ObjectPrototypeIsPrototypeOf,
  Promise,
  PromiseReject,
  PromiseResolve,
  PromisePrototypeThen,
  PromisePrototypeCatch,
  RangeError,
  Symbol,
  TypedArrayPrototypeGetBuffer,
  TypeError,
  Uint8Array,
} = primordials;

const MAX_PRIORITY = 2_147_483_647;
const BI_WEBTRANSPORT = 0x41;
const UNI_WEBTRANSPORT = 0x54;

function encodeVarint(x) {
  x = BigInt(x);
  if (x < 2n ** 6n) {
    return new Uint8Array([Number(x)]);
  }
  if (x < 2n ** 14n) {
    const s = Number(0b01n << 14n | x);
    const a = new Uint8Array(2);
    const v = new DataView(TypedArrayPrototypeGetBuffer(a));
    DataViewPrototypeSetUint16(v, 0, s, false);
    return a;
  }
  if (x < 2n ** 30n) {
    const s = Number(0b10n << 30n | x);
    const a = new Uint8Array(4);
    const v = new DataView(TypedArrayPrototypeGetBuffer(a));
    DataViewPrototypeSetUint32(v, 0, s, false);
    return a;
  }
  if (x < 2n ** 62n) {
    const s = 0b11n << 62n | x;
    const a = new Uint8Array(8);
    const v = new DataView(TypedArrayPrototypeGetBuffer(a));
    DataViewPrototypeSetBigUint64(v, 0, s, false);
    return a;
  }
  throw new RangeError("invalid varint");
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function concat(a, b) {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
}

const illegalConstructorKey = Symbol("illegalConstructorKey");

class WebTransport {
  [webidl.brand] = webidl.brand;
  #conn;
  #promise;
  #ready;
  // deno-lint-ignore prefer-primordials
  #closed = Promise.withResolvers();
  #settingsTx;
  #settingsRx;
  #connect;
  #headerUni;
  #headerBi;
  #reliability = "pending";
  #congestionControl = "default";
  #anticipatedConcurrentIncomingBidirectionalStreams = null;
  #anticipatedConcurrentIncomingUnidirectionalStreams = null;
  #incomingBidirectionalStreams;
  #incomingUnidirectionalStreams;
  #datagrams;

  constructor(url, options) {
    let promise;

    if (url === illegalConstructorKey) {
      promise = PromiseResolve(options);
    } else {
      const prefix = "Failed to construct 'WebTransport'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      url = webidl.converters.USVString(url, prefix, "Argument 1");
      options = webidl.converters.WebTransportOptions(
        options,
        prefix,
        "Argument 2",
      );

      let parsedURL;
      try {
        parsedURL = new URL(url, getLocationHref());
      } catch (e) {
        throw new DOMException(e.message, "SyntaxError");
      }

      switch (options.congestionControl) {
        case "throughput":
          this.#congestionControl = "throughput";
          break;
        case "low-latency":
          this.#congestionControl = "low-latency";
          break;
        default:
          this.#congestionControl = "default";
      }
      this.#anticipatedConcurrentIncomingBidirectionalStreams =
        options.anticipatedConcurrentIncomingBidirectionalStreams;
      this.#anticipatedConcurrentIncomingUnidirectionalStreams =
        options.anticipatedConcurrentIncomingUnidirectionalStreams;

      promise = PromisePrototypeThen(
        connectQuic({
          hostname: parsedURL.hostname,
          port: Number(parsedURL.port) || 443,
          keepAliveInterval: 4e3,
          maxIdleTimeout: 10e3,
          congestionControl: options.congestionControl,
          alpnProtocols: ["h3"],
          serverCertificateHashes: options.serverCertificateHashes,
        }),
        async (conn) => {
          const { connect, settingsTx, settingsRx } = await webtransportConnect(
            conn,
            // deno-lint-ignore prefer-primordials
            parsedURL.toString(),
          );

          return {
            conn,
            connect,
            settingsTx,
            settingsRx,
          };
        },
      );
    }

    PromisePrototypeCatch(promise, () => this.#closed.resolve());

    promise = PromisePrototypeThen(
      promise,
      ({ conn, connect, settingsTx, settingsRx }) => {
        this.#conn = conn;
        this.#closed.resolve(conn.closed);

        const sessionId = encodeVarint(connect.writable.id);
        this.#headerBi = concat(encodeVarint(BI_WEBTRANSPORT), sessionId);
        this.#headerUni = concat(encodeVarint(UNI_WEBTRANSPORT), sessionId);

        this.#settingsTx = settingsTx;
        this.#settingsRx = settingsRx;
        this.#connect = connect;

        this.#reliability = "supports-unreliable";

        return { conn, sessionId };
      },
    );

    this.#promise = promise;
    this.#datagrams = new WebTransportDatagramDuplexStream(
      illegalConstructorKey,
      promise,
    );
    this.#ready = PromisePrototypeThen(promise, () => undefined, (e) => {
      throw new WebTransportError(e.message);
    });
  }

  getStats() {
    webidl.assertBranded(this, WebTransportPrototype);
    return PromiseResolve({
      bytesSent: 0,
      packetsSent: 0,
      bytesLost: 0,
      packetsLost: 0,
      bytesReceived: 0,
      packetsReceived: 0,
      smoothedRtt: 0,
      rttVariation: 0,
      minRtt: 0,
      estimatedSendRate: null,
      atSendCapacity: false,
    });
  }

  get ready() {
    webidl.assertBranded(this, WebTransportPrototype);
    return this.#ready;
  }

  get reliability() {
    webidl.assertBranded(this, WebTransportPrototype);
    return this.#reliability;
  }

  get congestionControl() {
    webidl.assertBranded(this, WebTransportPrototype);
    return this.#congestionControl;
  }

  get anticipatedConcurrentIncomingUnidirectionalStreams() {
    webidl.assertBranded(this, WebTransportPrototype);
    return this.#anticipatedConcurrentIncomingUnidirectionalStreams;
  }

  get anticipatedConcurrentIncomingBidirectionalStreams() {
    webidl.assertBranded(this, WebTransportPrototype);
    return this.#anticipatedConcurrentIncomingBidirectionalStreams;
  }

  get closed() {
    webidl.assertBranded(this, WebTransportPrototype);
    return this.#closed.promise;
  }

  close(closeInfo) {
    webidl.assertBranded(this, WebTransportPrototype);
    closeInfo = webidl.converters.WebTransportCloseInfo(
      closeInfo,
      "Failed to execute 'close' on 'WebTransport'",
      "Argument 1",
    );
    if (!this.#conn) {
      throw new WebTransportError("WebTransport is not connected", {
        source: "session",
      });
    }
    this.#conn.close({
      closeCode: closeInfo.closeCode,
      reason: closeInfo.reason,
    });
  }

  get datagrams() {
    webidl.assertBranded(this, WebTransportPrototype);
    return this.#datagrams;
  }

  async createBidirectionalStream(options) {
    webidl.assertBranded(this, WebTransportPrototype);
    options = webidl.converters.WebTransportSendStreamOptions(
      options,
      "Failed to execute 'createBidirectionalStream' on 'WebTransport'",
      "Argument 1",
    );

    const { conn } = await this.#promise;
    const bidi = await conn.createBidirectionalStream({
      waitUntilAvailable: options.waitUntilAvailable,
    });

    bidi.writable.sendOrder = MAX_PRIORITY;
    const writer = bidi.writable.getWriter();
    await writer.write(this.#headerBi);
    writer.releaseLock();
    bidi.writable.sendOrder = options.sendOrder || 0;

    const wrapper = new WebTransportBidirectionalStream(
      illegalConstructorKey,
      bidi,
    );
    if (options.sendGroup) {
      wrapper.writable.sendGroup = options.sendGroup;
    }

    return wrapper;
  }

  get incomingBidirectionalStreams() {
    webidl.assertBranded(this, WebTransportPrototype);
    if (!this.#incomingBidirectionalStreams) {
      const readerPromise = PromisePrototypeThen(
        this.#promise,
        ({ conn }) => conn.incomingBidirectionalStreams.getReader(),
      );
      this.#incomingBidirectionalStreams = new ReadableStream({
        pull: async (controller) => {
          const reader = await readerPromise;
          const { value: bidi, done } = await reader.read();
          if (done) {
            controller.close();
          } else {
            const reader = bidi.readable.getReader({ mode: "byob" });
            const { value } = await reader.read(
              new Uint8Array(this.#headerBi.length),
            );
            reader.releaseLock();
            if (value && equal(value, this.#headerBi)) {
              controller.enqueue(
                new WebTransportBidirectionalStream(
                  illegalConstructorKey,
                  bidi,
                ),
              );
            }
          }
        },
      });
    }
    return this.#incomingBidirectionalStreams;
  }

  async createUnidirectionalStream(options) {
    webidl.assertBranded(this, WebTransportPrototype);
    options = webidl.converters.WebTransportSendStreamOptions(
      options,
      "Failed to execute 'createUnidirectionalStream' on 'WebTransport'",
      "Argument 1",
    );

    const { conn } = await this.#promise;
    const stream = await conn.createUnidirectionalStream({
      waitUntilAvailable: options.waitUntilAvailable,
    });

    stream.sendOrder = MAX_PRIORITY;
    const writer = stream.getWriter();
    await writer.write(this.#headerUni);
    writer.releaseLock();
    stream.sendOrder = options.sendOrder || 0;

    const wrapper = writableStream(stream);
    if (options.sendGroup) {
      wrapper.sendGroup = options.sendGroup;
    }

    return wrapper;
  }

  get incomingUnidirectionalStreams() {
    webidl.assertBranded(this, WebTransportPrototype);

    if (!this.#incomingUnidirectionalStreams) {
      const readerPromise = PromisePrototypeThen(
        this.#promise,
        ({ conn }) => conn.incomingUnidirectionalStreams.getReader(),
      );
      this.#incomingUnidirectionalStreams = new ReadableStream({
        pull: async (controller) => {
          const reader = await readerPromise;
          const { value: stream, done } = await reader.read();
          if (done) {
            controller.close();
          } else {
            const reader = stream.getReader({ mode: "byob" });
            const { value } = await reader.read(
              new Uint8Array(this.#headerUni.length),
            );
            reader.releaseLock();
            if (value && equal(value, this.#headerUni)) {
              controller.enqueue(
                readableStream(stream),
              );
            }
          }
        },
      });
    }

    return this.#incomingUnidirectionalStreams;
  }

  createSendGroup() {
    webidl.assertBranded(this, WebTransportPrototype);

    return new WebTransportSendGroup(illegalConstructorKey);
  }

  static get supportsReliableOnly() {
    return false;
  }
}
webidl.configureInterface(WebTransport);
const WebTransportPrototype = WebTransport.prototype;

async function upgradeWebTransport(conn) {
  const { url, connect, settingsTx, settingsRx } = await webtransportAccept(
    conn,
  );
  const wt = new WebTransport(illegalConstructorKey, {
    conn,
    connect,
    settingsTx,
    settingsRx,
  });
  wt.url = url;
  return wt;
}

function readableStream(stream) {
  return readableStreamForRid(
    getReadableStreamResourceBacking(stream).rid,
    false, // input stream already has cleanup
    WebTransportReceiveStream,
    illegalConstructorKey,
    stream,
  );
}

function writableStream(stream) {
  return writableStreamForRid(
    getWritableStreamResourceBacking(stream).rid,
    false, // input stream already has cleanup
    WebTransportSendStream,
    illegalConstructorKey,
    stream,
  );
}

class WebTransportBidirectionalStream {
  [webidl.brand] = webidl.brand;
  #inner;
  #readable;
  #writable;

  constructor(key, inner) {
    if (key !== illegalConstructorKey) {
      webidl.illegalConstructor();
    }
    this.#inner = inner;
  }

  get readable() {
    webidl.assertBranded(this, WebTransportBidirectionalStreamPrototype);
    if (!this.#readable) {
      this.#readable = readableStream(this.#inner.readable);
    }
    return this.#readable;
  }

  get writable() {
    webidl.assertBranded(this, WebTransportBidirectionalStreamPrototype);
    if (!this.#writable) {
      this.#writable = writableStream(this.#inner.writable);
    }
    return this.#writable;
  }
}
webidl.configureInterface(WebTransportBidirectionalStream);
const WebTransportBidirectionalStreamPrototype =
  WebTransportBidirectionalStream.prototype;

class WebTransportSendStream extends WritableStream {
  [webidl.brand] = webidl.brand;
  #inner;
  #sendGroup = null;

  constructor(brand, key, inner) {
    if (key !== illegalConstructorKey) {
      webidl.illegalConstructor();
    }
    super(brand);
    this.#inner = inner;
  }

  get sendGroup() {
    webidl.assertBranded(this, WebTransportSendStreamPrototype);
    return this.#sendGroup;
  }

  set sendGroup(value) {
    webidl.assertBranded(this, WebTransportSendStreamPrototype);
    value = webidl.converters.WebTransportSendGroup(
      value,
      "Failed to execute 'sendGroup' on 'WebTransportSendStream'",
    );
    this.#sendGroup = value;
  }

  get sendOrder() {
    webidl.assertBranded(this, WebTransportSendStreamPrototype);
    return this.#inner.sendOrder;
  }

  set sendOrder(sendOrder) {
    webidl.assertBranded(this, WebTransportSendStreamPrototype);
    sendOrder = webidl.converters["long long"](
      sendOrder,
      "Failed to execute 'sendOrder' on 'WebTransportSendStream'",
    );
    this.#inner.sendOrder = sendOrder;
  }

  getStats() {
    webidl.assertBranded(this, WebTransportSendStreamPrototype);
    return PromiseResolve({
      bytesWritten: 0,
      bytesSent: 0,
      bytesAcknowledged: 0,
    });
  }

  getWriter() {
    webidl.assertBranded(this, WebTransportSendStreamPrototype);
    return new WebTransportWriter(this);
  }
}
webidl.configureInterface(WebTransportSendStream);
const WebTransportSendStreamPrototype = WebTransportSendStream.prototype;

class WebTransportReceiveStream extends ReadableStream {
  [webidl.brand] = webidl.brand;
  #inner;

  constructor(brand, key, inner) {
    if (key !== illegalConstructorKey) {
      webidl.illegalConstructor();
    }
    super(brand);
    this.#inner = inner;
  }

  getStats() {
    webidl.assertBranded(this, WebTransportReceiveStreamPrototype);
    return PromiseResolve({
      bytesReceived: 0,
      bytesRead: 0,
    });
  }
}
webidl.configureInterface(WebTransportReceiveStream);
const WebTransportReceiveStreamPrototype = WebTransportReceiveStream.prototype;

class WebTransportWriter extends WritableStreamDefaultWriter {
  [webidl.brand] = webidl.brand;

  // atomicWrite() {}
}
webidl.configureInterface(WebTransportWriter);

class WebTransportDatagramDuplexStream {
  [webidl.brand] = webidl.brand;
  #promise;
  #conn;
  #sessionId;
  #readable;
  #readableController;
  #writable;
  #incomingMaxAge = Infinity;
  #outgoingMaxAge = Infinity;
  #incomingHighWaterMark = 1;
  #outgoingHighWaterMark = 5;
  #incomingDatagramsPullPromise = null;
  #incomingDatagramsQueue = [];
  #outgoingDatagramsQueue = [];
  #sending = false;

  constructor(key, promise) {
    if (key !== illegalConstructorKey) {
      webidl.illegalConstructor();
    }

    this.#promise = promise;
    PromisePrototypeThen(promise, ({ conn, sessionId }) => {
      this.#conn = conn;
      this.#sessionId = sessionId;
    });

    this.#receiveDatagrams();
  }

  async #receiveDatagrams() {
    const { conn, sessionId } = await this.#promise;
    while (true) {
      const queue = this.#incomingDatagramsQueue;
      const duration = this.#incomingMaxAge ?? Infinity;

      let datagram;
      try {
        datagram = await conn.readDatagram();
      } catch {
        break;
      }
      if (!equal(datagram.subarray(0, sessionId.length), sessionId)) {
        continue;
      }
      datagram = datagram.subarray(sessionId.length);

      ArrayPrototypePush(queue, { datagram, timestamp: DateNow() });

      const toBeRemoved = queue.length - this.#incomingHighWaterMark;
      while (toBeRemoved > 0) {
        ArrayPrototypeShift(queue);
      }

      while (queue.length > 0) {
        const { timestamp } = queue[0];
        if (DateNow() - timestamp > duration) {
          ArrayPrototypeShift(queue);
        } else {
          break;
        }
      }

      if (queue.length > 0 && this.#incomingDatagramsPullPromise) {
        const { datagram } = ArrayPrototypeShift(queue);
        const promise = this.#incomingDatagramsPullPromise;
        this.#incomingDatagramsPullPromise = null;
        this.#readableController.enqueue(datagram);
        promise.resolve(undefined);
      }
    }
  }

  async #sendDatagrams() {
    if (this.#sending) return;
    this.#sending = true;
    const { conn, sessionId } = await this.#promise;

    const queue = this.#outgoingDatagramsQueue;
    const duration = this.#outgoingMaxAge ?? Infinity;
    while (queue.length > 0) {
      const { bytes, timestamp, promise } = ArrayPrototypeShift(queue);

      if (DateNow() - timestamp > duration) {
        promise.resolve(undefined);
        continue;
      }

      if (bytes.length <= this.maxDatagramSize) {
        const datagram = concat(sessionId, bytes);
        try {
          await conn.sendDatagram(datagram);
        } catch {
          break;
        }
      }

      promise.resolve(undefined);
    }

    this.#sending = false;
  }

  get incomingMaxAge() {
    webidl.assertBranded(this, WebTransportDatagramDuplexStreamPrototype);
    return this.#incomingMaxAge;
  }

  set incomingMaxAge(value) {
    webidl.assertBranded(this, WebTransportDatagramDuplexStreamPrototype);
    value = webidl.converters["unrestricted double?"](
      value,
      "Failed to execute 'incomingMaxAge' on 'WebTransportDatagramDuplexStream'",
    );
    if (value < 0 || NumberIsNaN(value)) throw new RangeError();
    if (value === 0) value = null;
    this.#incomingMaxAge = value;
  }

  get outgoingMaxAge() {
    webidl.assertBranded(this, WebTransportDatagramDuplexStreamPrototype);
    return this.#outgoingMaxAge;
  }

  set outgoingMaxAge(value) {
    webidl.assertBranded(this, WebTransportDatagramDuplexStreamPrototype);
    value = webidl.converters["unrestricted double?"](
      value,
      "Failed to execute 'outgoingMaxAge' on 'WebTransportDatagramDuplexStream'",
    );
    if (value < 0 || NumberIsNaN(value)) throw new RangeError();
    if (value === 0) value = null;
    this.#outgoingMaxAge = value;
  }

  get incomingHighWaterMark() {
    webidl.assertBranded(this, WebTransportDatagramDuplexStreamPrototype);
    return this.#incomingHighWaterMark;
  }

  set incomingHighWaterMark(value) {
    webidl.assertBranded(this, WebTransportDatagramDuplexStreamPrototype);
    value = webidl.converters["unrestricted double"](
      value,
      "Failed to execute 'outgoingMaxAge' on 'WebTransportDatagramDuplexStream'",
    );
    if (value < 0 || NumberIsNaN(value)) throw new RangeError();
    if (value < 1) value = 1;
    this.#incomingHighWaterMark = value;
  }

  get outgoingHighWaterMark() {
    webidl.assertBranded(this, WebTransportDatagramDuplexStreamPrototype);
    return this.#outgoingHighWaterMark;
  }

  set outgoingHighWaterMark(value) {
    webidl.assertBranded(this, WebTransportDatagramDuplexStreamPrototype);
    value = webidl.converters["unrestricted double"](
      value,
      "Failed to execute 'outgoingMaxAge' on 'WebTransportDatagramDuplexStream'",
    );
    if (value < 0 || NumberIsNaN(value)) throw new RangeError();
    if (value < 1) value = 1;
    this.#outgoingHighWaterMark = value;
  }

  get maxDatagramSize() {
    webidl.assertBranded(this, WebTransportDatagramDuplexStreamPrototype);
    if (this.#conn) {
      return this.#conn.maxDatagramSize - this.#sessionId.length;
    }
    return 1024;
  }

  get readable() {
    webidl.assertBranded(this, WebTransportDatagramDuplexStreamPrototype);
    if (!this.#readable) {
      this.#readable = new ReadableStream({
        type: "bytes",
        start: (controller) => {
          PromisePrototypeThen(
            PromisePrototypeThen(this.#promise, ({ conn }) => conn.closed),
            () => {
              try {
                controller.close();
              } catch {
                // nothing
              }
            },
          );
          this.#readableController = controller;
        },
        pull: (controller) => {
          assert(this.#incomingDatagramsPullPromise === null);
          const queue = this.#incomingDatagramsQueue;
          if (queue.length === 0) {
            // deno-lint-ignore prefer-primordials
            this.#incomingDatagramsPullPromise = Promise.withResolvers();
            return this.#incomingDatagramsPullPromise.promise;
          }
          const { datagram } = ArrayPrototypeShift(queue);
          if (controller.byobRequest) {
            const view = controller.byobRequest.view;
            if (
              ObjectPrototypeIsPrototypeOf(DataViewPrototype, view) ||
              TypedArrayPrototypeGetLength(view) < datagram.length
            ) {
              return PromiseReject(new RangeError());
            }
            if (view.constructor.BYTES_PER_ELEMENT !== 1) {
              return PromiseReject(new TypedError());
            }
            view.set(datagram);
            controller.byobRequest.respond(datagram.length);
          } else {
            controller.enqueue(datagram);
          }
          return PromiseResolve(undefined);
        },
      }, { highWaterMark: 0 });
    }
    return this.#readable;
  }

  get writable() {
    webidl.assertBranded(this, WebTransportDatagramDuplexStreamPrototype);
    if (!this.#writable) {
      this.#writable = new WritableStream({
        write: (data) => {
          if (
            !(ObjectPrototypeIsPrototypeOf(ArrayBufferPrototype, data) ||
              ArrayBufferIsView(data))
          ) return PromiseReject(new TypeError());
          if (data.length > this.maxDatagramSize) {
            return PromiseResolve(undefined);
          }
          return new Promise((resolve, reject) => {
            const bytes = new Uint8Array(data.length);
            bytes.set(data);
            const chunk = {
              bytes,
              timestamp: DateNow(),
              promise: { resolve, reject },
            };
            ArrayPrototypePush(this.#outgoingDatagramsQueue, chunk);
            if (
              this.#outgoingDatagramsQueue.length < this.#outgoingHighWaterMark
            ) {
              resolve(undefined);
            }
            this.#sendDatagrams();
          });
        },
      });
    }
    return this.#writable;
  }
}
webidl.configureInterface(WebTransportDatagramDuplexStream);
const WebTransportDatagramDuplexStreamPrototype =
  WebTransportDatagramDuplexStream.prototype;

class WebTransportSendGroup {
  constructor(key) {
    if (key !== illegalConstructorKey) {
      webidl.illegalConstructor();
    }
  }

  getStats() {
    webidl.assertBranded(this, WebTransportSendGroupPrototype);
    return PromiseResolve({
      bytesWritten: 0,
      bytesSent: 0,
      bytesAcknowledged: 0,
    });
  }
}
webidl.configureInterface(WebTransportSendGroup);
const WebTransportSendGroupPrototype = WebTransportSendGroup.prototype;

class WebTransportError extends DOMException {
  #source;
  #streamErrorCode;

  constructor(message = "", init = { __proto__: null }) {
    super(message, "WebTransportError");
    this[webidl.brand] = webidl.brand;

    init = webidl.converters["WebTransportErrorOptions"](
      init,
      "Failed to construct 'WebTransportError'",
      "Argument 2",
    );

    this.#source = init.source;
    this.#streamErrorCode = init.streamErrorCode;
  }

  get source() {
    webidl.assertBranded(this, WebTransportErrorPrototype);
    return this.#source;
  }

  get streamErrorCode() {
    webidl.assertBranded(this, WebTransportErrorPrototype);
    return this.#streamErrorCode;
  }
}
webidl.configureInterface(WebTransportError);
const WebTransportErrorPrototype = WebTransportError.prototype;

webidl.converters.WebTransportSendGroup = webidl.createInterfaceConverter(
  "WebTransportSendGroup",
  WebTransportSendGroupPrototype,
);

webidl.converters.WebTransportSendStreamOptions = webidl
  .createDictionaryConverter("WebTransportSendStreamOptions", [
    {
      key: "sendGroup",
      converter: webidl.converters.WebTransportSendGroup,
    },
    {
      key: "sendOrder",
      converter: webidl.converters["long long"],
      defaultValue: 0,
    },
    {
      key: "waitUntilAvailable",
      converter: webidl.converters.boolean,
      defaultValue: false,
    },
  ]);

webidl.converters.WebTransportCloseInfo = webidl.createDictionaryConverter(
  "WebTransportCloseInfo",
  [
    {
      key: "closeCode",
      converter: webidl.converters["unsigned long"],
      defaultValue: 0,
    },
    {
      key: "reason",
      converter: webidl.converters.USVString,
      defaultValue: "",
    },
  ],
);

webidl.converters.WebTransportHash = webidl.createDictionaryConverter(
  "WebTransportHash",
  [
    {
      key: "algorithm",
      converter: webidl.converters.DOMString,
    },
    {
      key: "value",
      converter: webidl.converters.BufferSource,
    },
  ],
);

webidl.converters["sequence<WebTransportHash>"] = webidl
  .createSequenceConverter(webidl.converters.WebTransportHash);

webidl.converters.WebTransportCongestionControl = webidl.createEnumConverter(
  "WebTransportCongestionControl",
  [
    "default",
    "throughput",
    "low-latency",
  ],
);

webidl.converters.WebTransportOptions = webidl
  .createDictionaryConverter("WebTransportOptions", [
    {
      key: "allowPooling",
      converter: webidl.converters.boolean,
      defaultValue: false,
    },
    {
      key: "requireUnreliable",
      converter: webidl.converters.boolean,
      defaultValue: false,
    },
    {
      key: "serverCertificateHashes",
      converter: webidl.converters["sequence<WebTransportHash>"],
    },
    {
      key: "congestionControl",
      converter: webidl.converters.WebTransportCongestionControl,
      defaultValue: "default",
    },
    {
      key: "anticipatedConcurrentIncomingUnidirectionalStreams",
      converter: webidl.converters["unsigned short?"],
      defaultValue: null,
    },
    {
      key: "anticipatedConcurrentIncomingBidirectionalStreams",
      converter: webidl.converters["unsigned short?"],
      defaultValue: null,
    },
    {
      key: "protocols",
      converter: webidl.converters["sequence<DOMString>"],
      defaultValue: [],
    },
  ]);

webidl.converters.WebTransportErrorSource = webidl.createEnumConverter(
  "WebTransportErrorSource",
  ["stream", "session"],
);

webidl.converters.WebTransportErrorOptions = webidl.createDictionaryConverter(
  "WebTransportErrorOptions",
  [
    {
      key: "source",
      converter: webidl.converters.WebTransportErrorSource,
      defaultValue: "stream",
    },
    {
      key: "streamErrorCode",
      converter: webidl.converters["unsigned long?"],
      defaultValue: null,
    },
  ],
);

export {
  upgradeWebTransport,
  WebTransport,
  WebTransportBidirectionalStream,
  WebTransportDatagramDuplexStream,
  WebTransportError,
  WebTransportReceiveStream,
  WebTransportSendGroup,
  WebTransportSendStream,
};
