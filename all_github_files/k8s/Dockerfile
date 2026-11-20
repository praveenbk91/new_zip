FROM atlassian/confluence:9.2.9
USER root
RUN apt-get update && apt-get install -y curl && apt-get install -y vim nfs-common sudo
RUN curl -L -o /opt/atlassian/confluence/confluence/WEB-INF/lib/ojdbc11.jar -H "Cookie: oraclelicense=accept-securebackup-cookie" https://download.oracle.com/otn-pub/otn_software/jdbc/237/ojdbc11.jar
RUN chmod 550 /opt/atlassian/confluence/confluence/WEB-INF/lib/ojdbc11.jar && \
    chown confluence:root /opt/atlassian/confluence/confluence/WEB-INF/lib/ojdbc11.jar
USER confluence
