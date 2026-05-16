FROM node:22.12-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production
# Build-time placeholder for Prisma generation. The deployment environment
# injects the real managed Postgres URL at runtime.
ENV DATABASE_URL="postgresql://postgres:postgres@localhost:5432/script_sentinel?schema=public"

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force
# Remove CLI packages since we don't need them in production by default.
# Remove this line if you want to run CLI commands in your container.
RUN npm remove @shopify/cli

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
