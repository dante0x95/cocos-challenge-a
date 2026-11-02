# v1 del lab (Z). Contexto: la raíz del repo, por el lockfile: express y pg son las mismas
# versiones que usa la API. Node 22 corre el TypeScript de server.ts quitándole los tipos, sin build.
FROM node:22-alpine
WORKDIR /app
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY lab/z/server.ts ./
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "--no-warnings", "server.ts"]
