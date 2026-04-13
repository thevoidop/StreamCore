import os
from http.server import *  # type: ignore

PORT = 8000


class Server(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/video":
            file_size = os.path.getsize("video.mp4")

            range_header = self.headers["Range"]
            range_value = range_header.split("=")[1]
            parts = range_value.split("-")

            start = int(parts[0])
            end = int(parts[1]) if parts[1] else file_size - 1
            length = int(end) - int(start) + 1

            with open("video.mp4", "rb") as f:
                f.seek(start)
                data = f.read(length)

            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Content-Length", str(length))
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Expose-Headers", "Content-Range")
            self.end_headers()

            self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Range")
        self.end_headers()


try:
    app = HTTPServer(("", PORT), Server)
    print(f"Server running at http://localhost:{PORT}")
    app.serve_forever()
except KeyboardInterrupt:
    print("\nShutting down the server...")
