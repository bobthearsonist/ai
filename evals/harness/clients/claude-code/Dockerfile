FROM node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d
WORKDIR /opt/client
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && ./node_modules/.bin/claude --version \
    && node --version \
    && test "$(./node_modules/.bin/claude --version)" = "2.1.291 (Claude Code)" \
    && test "$(node --version)" = "v22.22.1"
COPY runtime.mjs policy.mjs task-runtime.mjs task-policy.mjs mock-protocol.mjs ./
USER node
ENTRYPOINT ["node", "/opt/client/runtime.mjs"]
