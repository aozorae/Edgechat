FROM node:22

WORKDIR /app

# TASK-151 今晚轨：钉死运行时版本（4.152 workerd 出网超时实测、4.80 全链实证通）。
# 基础镜像 digest 执行时取（docker manifest inspect node:22）并记入回执，不在本文件写死以防错值。
RUN npm install -g wrangler@4.80.0

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

EXPOSE 8787

ENV NODE_ENV=production

CMD ["wrangler", "dev", "--port", "8787", "--ip", "0.0.0.0", "--local"]
