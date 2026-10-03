FROM node:22-alpine

RUN apk update && apk upgrade && rm -rf /var/cache/apk/*

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && npm audit --audit-level=high || true

COPY server.js index.html style.css app.js signaling.js ./

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000
CMD ["node", "server.js"]