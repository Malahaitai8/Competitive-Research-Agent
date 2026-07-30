import logging
import os
from urllib.parse import urlparse


PROXY_ENV_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)

DEAD_LOOPBACK_PROXY_PORTS = {"9"}


def _is_dead_loopback_proxy(value: str) -> bool:
    if not value:
        return False
    parsed = urlparse(value if "://" in value else f"http://{value}")
    host = (parsed.hostname or "").lower()
    port = str(parsed.port or "")
    return host in {"127.0.0.1", "localhost", "::1"} and port in DEAD_LOOPBACK_PROXY_PORTS


def sanitize_proxy_environment() -> dict[str, str]:
    removed = {}
    for key in PROXY_ENV_KEYS:
        value = os.environ.get(key)
        if value and _is_dead_loopback_proxy(value):
            removed[key] = value
            os.environ.pop(key, None)
    if removed:
        logging.getLogger(__name__).warning(
            "Removed dead loopback proxy environment variables: %s",
            ", ".join(sorted(removed)),
        )
    return removed
