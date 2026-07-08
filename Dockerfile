# Optional convenience image for the PPAD stub. Not required — `npm start` works
# without Docker (the stub has no external dependencies).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
EXPOSE 4010
CMD ["npm", "run", "start"]
