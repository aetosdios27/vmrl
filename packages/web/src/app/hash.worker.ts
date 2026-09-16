// Hashes a File off the main thread. Web Crypto has no streaming digest, so the
// whole file is buffered; the worker only keeps the UI responsive.
addEventListener("message", async (event) => {
  const file = (event as MessageEvent<File>).data;
  try {
    const bytes = await file.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    postMessage({ ok: true, hex: `0x${hex}` });
  } catch (error) {
    postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
