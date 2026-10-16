FROM node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS install
WORKDIR /opt/client
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --update-notifier=false
RUN test "$(./node_modules/opencode-linux-x64/bin/opencode --version)" = "1.14.28"
RUN test "$(node --version)" = "v22.22.1"
RUN find node_modules/@vscode/ripgrep-linux-x64 -name rg -type f -exec install -m 755 {} /usr/local/bin/rg \;

FROM node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d
COPY --from=install /opt/client /opt/client
COPY --from=install /usr/local/bin/rg /usr/local/bin/rg
COPY index.mjs constants.mjs case-spec.mjs task-policy.mjs native-events.mjs native-spec.mjs native-evidence.mjs native-session.mjs task-files.mjs probe.mjs scripted-protocol.mjs task-spec.mjs task-audit.mjs task-runtime.mjs /opt/fixture/
USER 1000:1000
ENV HOME=/work/home XDG_CONFIG_HOME=/work/config XDG_CACHE_HOME=/work/cache XDG_DATA_HOME=/work/data XDG_STATE_HOME=/work/state
ENV OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_DEFAULT_PLUGINS=1 OPENCODE_DISABLE_LSP_DOWNLOAD=1 OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_EXTERNAL_SKILLS=1
WORKDIR /work
ENTRYPOINT ["node", "/opt/fixture/probe.mjs"]
