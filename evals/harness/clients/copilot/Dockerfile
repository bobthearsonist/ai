FROM node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d
WORKDIR /opt/fixture
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
RUN HOME=/opt/copilot-cache COPILOT_HOME=/opt/copilot-cache/config ./node_modules/.bin/copilot --version
COPY *.mjs ./
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/fixture/probe.mjs"]
