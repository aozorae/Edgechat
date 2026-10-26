FROM node:22

WORKDIR /app

RUN npm install -g wrangler

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

EXPOSE 8787

ENV NODE_ENV=production

CMD ["wrangler", "dev", "--port", "8787", "--ip", "0.0.0.0", "--local"]
