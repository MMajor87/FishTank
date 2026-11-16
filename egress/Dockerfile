FROM alpine:3.20
RUN apk add --no-cache iptables
COPY egress.sh /egress.sh
RUN chmod +x /egress.sh
CMD ["/egress.sh"]
