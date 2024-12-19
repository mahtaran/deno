const x = new WebTransport("https://localhost:4443");

x.ready.then(async () => {
  const bi = await x.createBidirectionalStream();

  {
    const writer = bi.writable.getWriter();
    await writer.write(new Uint8Array([1, 0, 1, 0]));
    writer.releaseLock();
  }

  {
    const reader = bi.readable.getReader();
    console.log(await reader.read());
    reader.releaseLock();
  }

  {
    const uni = await x.createUnidirectionalStream();
    const writer = uni.getWriter();
    await writer.write(new Uint8Array([0, 2, 0, 2]));
    writer.releaseLock();
  }

  {
    const uni =
      (await x.incomingUnidirectionalStreams.getReader().read()).value;
    const reader = uni.getReader();
    console.log(await reader.read());
    reader.releaseLock();
  }

  console.log("max datagram", x.datagrams.maxDatagramSize);
  await x.datagrams.writable.getWriter().write(new Uint8Array([3, 0, 3, 0]));
  console.log(await x.datagrams.readable.getReader().read());

  x.close();
});
