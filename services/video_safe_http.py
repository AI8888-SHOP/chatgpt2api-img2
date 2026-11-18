"""Public media GET with pinned DNS, TLS verification and no redirects/proxy/key."""
import ipaddress
import socket
from contextlib import contextmanager
from urllib.parse import urlsplit
import urllib3


class MediaHTTPError(ValueError):
    def __init__(self, status):
        self.status = int(status)
        super().__init__("media HTTP " + str(self.status))


@contextmanager
def public_media(url):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.port not in {None, 443}:
        raise ValueError("media requires public HTTPS URL")
    addresses = {item[4][0] for item in socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)}
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ValueError("non-public media address")
    pool = urllib3.HTTPSConnectionPool(next(iter(addresses)), port=443, server_hostname=parsed.hostname,
                                     assert_hostname=parsed.hostname, cert_reqs="CERT_REQUIRED", timeout=urllib3.Timeout(connect=10, read=30))
    response = None
    try:
        response = pool.urlopen("GET", (parsed.path or "/") + ("?" + parsed.query if parsed.query else ""),
                                headers={"Host": parsed.hostname}, redirect=False, retries=False, preload_content=False)
        if response.status != 200:
            raise MediaHTTPError(response.status)
        yield response
    finally:
        if response:
            response.close()
        pool.close()
