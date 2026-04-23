"""Python client experiments — httpx and requests.

Usage:
    python client-python.py <lib> <scenario>
      lib: httpx | requests
      scenario:
        envproxy-explicit-header
        envproxy-no-header
        no-proxy-explicit-header
        api-proxy-explicit-header   # explicit proxy param

Echoes whether the custom header and CAIRN_LANE_ID env were seen by the echo server.
"""
import os
import sys
import json

ECHO = "http://127.0.0.1:18081/test"
PROXY = "http://127.0.0.1:18080"

lib = sys.argv[1]
scenario = sys.argv[2]
pid = os.getpid()
lane = os.environ.get("CAIRN_LANE_ID")

tag = f"[py lib={lib} scenario={scenario} pid={pid} CAIRN_LANE_ID={lane}]"
print(tag, "HTTP_PROXY =", os.environ.get("HTTP_PROXY"))
print(tag, "http_proxy =", os.environ.get("http_proxy"))

headers = {}
if "explicit-header" in scenario:
    headers["x-cairn-lane-id"] = "test-123"

if lib == "httpx":
    import httpx

    kwargs = {}
    if scenario == "api-proxy-explicit-header":
        # httpx 0.28 syntax: proxy= (singular) for single proxy.
        kwargs["proxy"] = PROXY
    # Else: rely on env (httpx reads trust_env=True by default).
    with httpx.Client(**kwargs) as c:
        r = c.get(ECHO, headers=headers)
        data = r.json()

elif lib == "requests":
    import requests

    kwargs = {}
    if scenario == "api-proxy-explicit-header":
        kwargs["proxies"] = {"http": PROXY, "https": PROXY}
    # Else: requests also respects HTTP_PROXY env by default.
    r = requests.get(ECHO, headers=headers, **kwargs)
    data = r.json()
else:
    print("unknown lib:", lib); sys.exit(2)

print(tag, "echo headers.x-cairn-lane-id =", data["headers"].get("x-cairn-lane-id", "(absent)"))
print(tag, "echo url =", data["url"])
