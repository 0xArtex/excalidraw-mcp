# Dockerfile for MCP Excalidraw Server (Hosted Mode)
# This builds the MCP server with SSE transport for remote connections

# Stage 1: Build backend (TypeScript compilation)
FROM node:18-slim AS builder

WORKDIR /app

# Copy package.json only (not package-lock.json to avoid platform issues)
COPY package.json ./

# Install all dependencies (including TypeScript compiler)
RUN npm install && npm cache clean --force

# Copy backend source
COPY src ./src
COPY tsconfig.json ./

# Compile TypeScript
RUN npm run build:server

# Stage 2: Production MCP Server
FROM node:18-slim AS production

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --gid 1001 nodejs

WORKDIR /app

# Copy package.json only (not package-lock.json to avoid platform issues)
COPY package.json ./

# Install only production dependencies
RUN npm install --only=production && npm cache clean --force

# Copy compiled backend (MCP server only)
COPY --from=builder /app/dist ./dist

# Set ownership to nodejs user
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Set environment variables with defaults
ENV NODE_ENV=production
ENV EXPRESS_SERVER_URL=http://localhost:3000
ENV PUBLIC_URL=http://localhost:3000
ENV MCP_TRANSPORT_MODE=sse
ENV MCP_PORT=3001

# Expose MCP SSE port
EXPOSE 3001

# Run MCP server in SSE mode
CMD ["node", "dist/index.js"]

# Labels for metadata
LABEL org.opencontainers.image.source="https://github.com/0xArtex/excalidraw-mcp"
LABEL org.opencontainers.image.description="MCP Excalidraw Server - Hosted SSE mode for remote AI agents"
LABEL org.opencontainers.image.licenses="MIT"
