FROM node:22@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384

WORKDIR /app

# TASK-151 今晚轨：钉死运行时版本（4.152 workerd 出网超时实测、4.80 全链实证通）。
# 基础镜像摘要已写死：取回时刻 2026-10-28 10:29:27 +0800；证据原文＝服务器 /home/zyb/edgechat-prod/raw-task151/node22-manifest-digest.txt
# （578 字节 / sha256 c13f3b5b2d1cb924905c6378041ddc367077312fbb6e46217e05136e2734d137 / 10:30:02）。
# 不确定性如实标注：该值类型（多架构清单摘要 vs 单架构 manifest 摘要）未用 buildx 交叉验证
# （服务器 buildx 直连 registry 超时、本机无 docker 无法对照），仅 docker pull 语义与 RepoDigests 双证一致；
# 本次构建平台为 amd64 不影响本次部署，将来换架构机器须重取。
RUN npm install -g wrangler@4.80.0

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

EXPOSE 8787

ENV NODE_ENV=production

CMD ["wrangler", "dev", "--port", "8787", "--ip", "0.0.0.0", "--local"]
