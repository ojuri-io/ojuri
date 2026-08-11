# Temporary: layers the onnxruntime fix from mla-service/requirements.txt onto
# the last published mla image, because the fix landed after that image was
# built and the box has no working MLA until a new one ships.
#
# Delete this file and the `mla` build override in docker-compose.ec2.yml once
# a release carries onnxruntime>=1.19.2. Tracked in issue #122.
ARG OJURI_VERSION=v1
FROM ghcr.io/ojuri-io/mla:${OJURI_VERSION}

RUN pip install --no-cache-dir onnxruntime==1.19.2
