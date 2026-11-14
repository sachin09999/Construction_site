FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000

# Install build dependencies for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Clean up build tools to keep image small
RUN apt-get purge -y --auto-remove python3 make g++

# Copy application source code and web assets
COPY server.js ./
COPY src ./src
COPY public ./public

EXPOSE 4000

CMD ["npm", "start"]

