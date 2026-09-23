"""Run the single local API/ML worker: python -m backend [--port 8000]."""

import argparse
import os

import uvicorn


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--data-dir", help="Persistent data directory; defaults to DATA_DIR or ./data")
    args = parser.parse_args()
    if args.data_dir:
        os.environ["DATA_DIR"] = args.data_dir
    # One process owns the durable queue. GPU deployments use an SSH tunnel
    # to this loopback listener, with Ollama on that same machine.
    uvicorn.run("backend.app.main:app", host="127.0.0.1", port=args.port, workers=1)


if __name__ == "__main__":
    main()
