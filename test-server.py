"""
Tiny HTTP server that serves pages on suspicious-looking paths.
Navigate to URLs like:
  http://localhost:8888/login?user=admin&pass=x&token=y&ref=z&sid=1&uid=2&cid=3&tid=4&pid=5
  (no_tls + many_params = 16 pts)

  http://localhost:8888/aaaaaaa...  (200+ chars)
  (no_tls + long_url = 16 pts)

To hit 70+ (threat), we need a real domain. Instead, use the extension's
popup to see scores, and test the overlay by temporarily lowering the threshold.
"""
from http.server import HTTPServer, SimpleHTTPRequestHandler
import sys

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(f"""
        <html><body>
        <h1>Test Page</h1>
        <p>Path: {self.path}</p>
        <p>This page is served over HTTP (no TLS) for testing URLGuard signals.</p>
        </body></html>
        """.encode())

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8888
print(f"Serving on http://localhost:{port}")
print(f"Test URLs:")
print(f"  http://localhost:{port}/?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10")
print(f"  http://localhost:{port}/{'x'*200}")
HTTPServer(('localhost', port), Handler).start()
