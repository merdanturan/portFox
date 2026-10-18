// Tiny HTTP server used by the demo recording (demo.tape) and manual testing.
import http from "node:http";

const port = Number(process.argv[2] || 3000);
http
  .createServer((_req, res) => res.end("hello from portfox\n"))
  .listen(port, "127.0.0.1", () => console.log(`demo server listening on http://127.0.0.1:${port}`));
