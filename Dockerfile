FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
RUN mkdir /data && chown node:node /data
USER node
ENV SHADOWGRAPH_FILE=/data/memory.json
ENV SHADOWGRAPH_MCP_COMPACT=1
ENTRYPOINT ["node", "src/mcp.js"]
