ARG NODE_VERSION=26.13.1
FROM node:${NODE_VERSION}-alpine3.24 AS workspace
WORKDIR /app
ENV CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm install --global "pnpm@$(node -p 'require("./package.json").packageManager.split("@")[1]')"

FROM workspace AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM workspace AS production-dependencies
RUN pnpm --filter @kestrel-it/api... install --prod --frozen-lockfile

FROM node:${NODE_VERSION}-alpine3.24 AS api
# Keep the Node runtime and remove package managers from the production filesystem.
RUN rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
ENV NODE_ENV=production STORAGE_LOCAL_ROOT=/var/lib/kestrel/storage
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=production-dependencies /app/apps/api/node_modules ./apps/api/node_modules
COPY --chown=node:node --from=production-dependencies /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --chown=node:node --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --chown=node:node --from=build /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --chown=node:node --from=build /app/packages/shared/dist ./packages/shared/dist
RUN install -d -o node -g node /var/lib/kestrel/storage
USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM nginx:1.30.8-alpine AS web
ENV KESTREL_API_ORIGIN=http://kestrel-it-api:3000
COPY deploy/images/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist/kestrel-web/browser/ /usr/share/nginx/html/
EXPOSE 80

FROM dxflrs/garage:v2.2.0 AS garage-binary

FROM alpine:3.24.4 AS garage-init
COPY --from=garage-binary /garage /garage
COPY deploy/garage/init.sh /init.sh
ENTRYPOINT ["/bin/sh", "/init.sh"]
