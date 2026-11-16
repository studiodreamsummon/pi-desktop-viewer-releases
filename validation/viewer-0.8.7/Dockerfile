FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
WORKDIR /product
ENV NODE_ENV=production HOST=0.0.0.0 PORT=18081 VIEWER_DATA_DIR=/data/viewer VIEWER_DOWNLOAD_PATH=/product/desktop-viewer/dist/PiDesktopViewer.zip VIEWER_EXE_DOWNLOAD_PATH=/product/desktop-viewer/dist/PiDesktopViewer.exe VIEWER_CLIENT_ORIGIN=https://pi-desktop-viewer-client.pi-desktop-manager-relay-mvp.workers.dev
COPY --chown=node:node desktop-viewer/package.json desktop-viewer/server.mjs desktop-viewer/protocol.mjs desktop-viewer/access-protocol.mjs desktop-viewer/access-network.mjs desktop-viewer/access-clock.mjs desktop-viewer/access-trust.json ./desktop-viewer/
COPY --chown=node:node desktop-viewer/lib/ ./desktop-viewer/lib/
COPY --chown=node:node desktop-viewer/public/index.html desktop-viewer/public/bootstrap.js desktop-viewer/public/local.js desktop-viewer/public/web-i18n.mjs desktop-viewer/public/local.css desktop-viewer/public/icon.svg ./desktop-viewer/public/
COPY --chown=node:node desktop-viewer/dist/PiDesktopViewer.zip ./desktop-viewer/dist/PiDesktopViewer.zip
COPY --chown=node:node desktop-viewer/dist/PiDesktopViewer.exe ./desktop-viewer/dist/PiDesktopViewer.exe
COPY --chown=node:node app/lib/mirror-client.mjs app/lib/mirror-access.mjs ./app/lib/
RUN mkdir -p /data/viewer && chown node:node /data/viewer && chmod 700 /data/viewer
USER node
EXPOSE 18081
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:18081/health').then(async r=>{if(!r.ok||(await r.json()).ok!==true)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "desktop-viewer/server.mjs"]
