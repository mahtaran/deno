// Copyright 2018-2024 the Deno authors. All rights reserved. MIT license.
import { primordials } from "ext:core/mod.js";
import { getLocationHref } from "ext:deno_web/12_location.js";
import * as webidl from "ext:deno_webidl/00_webidl.js";
import {
  connectQuic,
  webtransportAccept,
  webtransportConnect,
} from "ext:deno_net/03_quic.js";
import {
  getReadableStreamResourceBacking,
  getWritableStreamResourceBacking,
  ReadableStream,
  readableStreamForRid,
  WritableStream,
  WritableStreamDefaultWriter,
  writableStreamForRid,
} from "ext:deno_web/06_streams.js";

const {
  DataView,
  BigInt,
  Number,
  Uint8Array,
  PromisePrototypeThen,
  PromisePrototypeCatch,
  DataViewPrototypeSetUint16,
  DataViewPrototypeSetUint32,
  DataViewPrototypeSetBigUint64,
  RangeError,
  TypedArrayPrototypeGetBuffer,
  Symbol,
} = primordials;

const MAX_PRIORITY = 2_147_483_647;
const BI_WEBTRANSPORT = 0x41;
const UNI_WEBTRANSPORT = 0x54;

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

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

function concat(a, b) {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
}

class WebTransportSendGroup {
  constructor(key) {
    if (key !== illegalConstructorKey) {
      webidl.illegalConstructor();
    }
  }
}

const illegalConstructorKey = Symbol("illegalConstructorKey");

class WebTransport {
  [webidl.brand] = webidl.brand;
  #conn;
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
      const conn = options;
      promise = (async () => {
        const { url, connect, settingsTx, settingsRx } =
          await webtransportAccept(conn);
        this.url = url;
        return {
          conn,
          connect,
          settingsTx,
          settingsRx,
        };
      })();
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

    this.#datagrams = new WebTransportDatagramDuplexStream(
      illegalConstructorKey,
      promise,
    );

    this.#ready = PromisePrototypeThen(promise, () => undefined);
  }

  getStats() {
    webidl.assertBranded(this, WebTransportPrototype);
    return PromiseResolve({});
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

    const bidi = await this.#conn.createBidirectionalStream({
      waitUntilAvailable: options.waitUntilAvailable,
    });

    bidi.writable.sendOrder = MAX_PRIORITY;
    const writer = bidi.writable.getWriter();
    await writer.write(this.#headerBi);
    writer.releaseLock();
    bidi.writable.sendOrder = options.sendOrder || 0;

    return new WebTransportBidirectionalStream(
      illegalConstructorKey,
      bidi,
      options.sendGroup,
    );
  }

  get incomingBidirectionalStreams() {
    webidl.assertBranded(this, WebTransportPrototype);

    if (!this.#incomingBidirectionalStreams) {
      this.#incomingBidirectionalStreams = this.#conn
        .incomingBidirectionalStreams.pipeThrough(
          new TransformStream({
            transform: async (bidi, controller) => {
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
            },
          }),
        );
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

    const stream = await this.#conn.createUnidirectionalStream({
      waitUntilAvailable: options.waitUntilAvailable,
    });

    stream.sendOrder = MAX_PRIORITY;
    const writer = stream.getWriter();
    await writer.write(this.#headerUni);
    writer.releaseLock();
    stream.sendOrder = options.sendOrder || 0;

    return writableStream(stream, options.sendGroup);
  }

  get incomingUnidirectionalStreams() {
    webidl.assertBranded(this, WebTransportPrototype);

    if (!this.#incomingUnidirectionalStreams) {
      this.#incomingUnidirectionalStreams = this.#conn
        .incomingUnidirectionalStreams.pipeThrough(
          new TransformStream({
            transform: async (stream, controller) => {
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
            },
          }),
        );
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

const WebTransportPrototype = WebTransport.prototype;

function upgradeWebTransport(quicConn) {
  return new WebTransport(illegalConstructorKey, quicConn);
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

function writableStream(stream, sendGroup) {
  return writableStreamForRid(
    getWritableStreamResourceBacking(stream).rid,
    false, // input stream already has cleanup
    WebTransportSendStream,
    illegalConstructorKey,
    stream,
    sendGroup,
  );
}

class WebTransportBidirectionalStream {
  [webidl.brand] = webidl.brand;
  #inner;
  #readable;
  #writable;
  #sendGroup;

  constructor(key, inner, sendGroup) {
    if (key !== illegalConstructorKey) {
      webidl.illegalConstructor();
    }
    this.#inner = inner;
    this.#sendGroup = sendGroup;
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
      this.#writable = writableStream(this.#inner.writable, this.#sendGroup);
    }
    return this.#writable;
  }
}

const WebTransportBidirectionalStreamPrototype =
  WebTransportBidirectionalStream.prototype;

class WebTransportSendStream extends WritableStream {
  [webidl.brand] = webidl.brand;
  #inner;
  #sendGroup;

  constructor(brand, key, inner, sendGroup) {
    if (key !== illegalConstructorKey) {
      webidl.illegalConstructor();
    }
    super(brand);
    this.#inner = inner;
    this.#sendGroup = sendGroup;
  }

  get sendGroup() {
    webidl.assertBranded(this, WebTransportSendStreamPrototype);
    return this.#sendGroup;
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
  }

  getWriter() {
    webidl.assertBranded(this, WebTransportSendStreamPrototype);
    return new WebTransportWriter(this);
  }
}

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
  }
}

const WebTransportReceiveStreamPrototype = WebTransportReceiveStream.prototype;

class WebTransportWriter extends WritableStreamDefaultWriter {
  [webidl.brand] = webidl.brand;

  // atomicWrite() {}
}

class WebTransportDatagramDuplexStream {
  [webidl.brand] = webidl.brand;
  #promise;
  #conn;
  #sessionId;
  #readable;
  #writable;

  constructor(key, promise) {
    if (key !== illegalConstructorKey) {
      webidl.illegalConstructor();
    }

    this.#promise = promise;
    PromisePrototypeThen(promise, ({ conn, sessionId }) => {
      this.#conn = conn;
      this.#sessionId = sessionId;
    });
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
        },
        pull: async (controller) => {
          const { conn, sessionId } = await this.#promise;
          const data = await conn.readDatagram();
          if (equal(data.subarray(0, sessionId.length), sessionId)) {
            controller.enqueue(data.subarray(sessionId.length));
          }
        },
      });
    }
    return this.#readable;
  }

  get writable() {
    webidl.assertBranded(this, WebTransportDatagramDuplexStreamPrototype);
    if (!this.#writable) {
      this.#writable = new WritableStream({
        write: async (chunk) => {
          if (chunk.length > this.maxDatagramSize) return;
          const { conn, sessionId } = await this.#promise;
          await conn.sendDatagram(concat(sessionId, chunk));
        },
      });
    }
    return this.#writable;
  }
}

const WebTransportDatagramDuplexStreamPrototype =
  WebTransportDatagramDuplexStream.prototype;

webidl.converters.WebTransportSendGroup = webidl.createInterfaceConverter(
  "WebTransportSendGroup",
  WebTransportSendGroup.prototype,
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

export {
  upgradeWebTransport,
  WebTransport,
  WebTransportBidirectionalStream,
  WebTransportDatagramDuplexStream,
  WebTransportReceiveStream,
  WebTransportSendGroup,
  WebTransportSendStream,
};
