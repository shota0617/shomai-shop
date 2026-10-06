FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
