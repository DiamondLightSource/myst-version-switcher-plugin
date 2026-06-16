# The devcontainer should use the developer target and run as root with podman
# or docker with user namespaces.
FROM ghcr.io/diamondlightsource/ubuntu-devcontainer:resolute AS developer

RUN apt-get update -y && apt-get install -y --no-install-recommends \
    npm \
    && apt-get dist-clean
