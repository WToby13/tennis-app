# Analysis-proxy transcoder. Runs as a one-shot Fargate task, one per match.
#
# Alpine + ffmpeg + aws-cli + curl is all this needs — the encoding spec lives in
# the web app and arrives as arguments, so there's no application code here to
# keep in sync.
FROM alpine:3.20

RUN apk add --no-cache ffmpeg aws-cli curl

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Never run as root; the task only ever touches /tmp.
RUN adduser -D -u 10001 transcoder
USER transcoder

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
