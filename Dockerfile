FROM node:20-alpine

WORKDIR /app

# 의존성: mssql/mysql2/bcryptjs/xlsx 외 추가
#   · date-fns (날짜 처리)
RUN npm init -y && npm install mssql mysql2 bcryptjs xlsx date-fns

# 답례품 앱 복사
# 최상위 JS 는 글롭으로 통째 — 파일을 새로 만들 때마다 COPY 줄을 잊어
#   런타임에 'Cannot find module' 이 나는 일이 반복됐다 (channel-probe.js, 2026-08-13).
COPY pricing-prototype/daeryepum/*.js ./
COPY pricing-prototype/daeryepum/index.html ./
COPY pricing-prototype/daeryepum/barungift/ ./barungift/
COPY pricing-prototype/daeryepum/coupang/ ./coupang/
COPY pricing-prototype/daeryepum/naver/ ./naver/
COPY pricing-prototype/daeryepum/cafe24/ ./cafe24/
COPY pricing-prototype/daeryepum/ga/ ./ga/
COPY pricing-prototype/daeryepum/manual.html ./
COPY pricing-prototype/daeryepum/manual-assets/ ./manual-assets/

RUN mkdir -p /app/data

RUN addgroup --system --gid 1001 appgroup
RUN adduser --system --uid 1001 appuser
RUN chown -R appuser:appgroup /app

USER appuser

# Docker Manager 볼륨 마운트 경로: /app/data (배포 시 데이터 보존)
VOLUME /app/data

EXPOSE 3000

ENV PORT=3000
ENV BASE_PATH=/c/barungift
ENV NODE_ENV=production
ENV GOOGLE_CLIENT_ID=469142074640-i9q13bl4c6l42pspfb1414bb0sr7arn9.apps.googleusercontent.com

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
