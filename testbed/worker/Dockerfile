# Python 3.12 rather than the host's 3.14: the Temporal SDK ships wheels for
# 3.12, and keeping the SDK in the image means nothing is installed on the
# host (whose interpreter is EXTERNALLY-MANAGED anyway).
FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir "temporalio==1.9.0"

COPY workflows.py worker.py seed.py ./

CMD ["python", "worker.py"]
