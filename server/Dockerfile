# The sync api. Nothing is installed and nothing is built - node:sqlite is builtin from 22.5,
# so the whole thing is the three files in this folder on top of a stock node image.
FROM node:24-alpine
WORKDIR /app

COPY server/store.mjs server/api.mjs ./server/

# the store lives on a volume, not in the image. it is the one thing in here that cannot
# be rebuilt from the repo, so it is also the one thing worth backing up
ENV TASKBOARD_STORE=/data/taskboard.db
ENV TASKBOARD_PORT=4320
VOLUME /data
EXPOSE 4320

CMD ["node", "server/api.mjs"]
