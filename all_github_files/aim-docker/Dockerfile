# Use a slim base image (AiM provides its own Tomcat)
FROM debian:bullseye-slim

# Set working directory
WORKDIR /home

# Install tar (for .tgz extraction) and curl (for ojdbc11.jar)
# Clean up apt lists to reduce image size
RUN apt-get update && apt-get install -y tar curl && rm -rf /var/lib/apt/lists/*

# Copy the AiM 14.1 test tgz file
# Place aim141test.tgz in the same directory as the Dockerfile
COPY aim141test.tgz /home/

# Extract the tgz to /home/aim141test and remove the tgz file
RUN tar -xzf aim141test.tgz -C /home/ && rm aim141test.tgz

# Download ojdbc11.jar for Oracle 19c
RUN curl -L -o /home/aim141test/lib/ojdbc11.jar -H "Cookie: oraclelicense=accept-securebackup-cookie" https://download.oracle.com/otn-pub/otn_software/jdbc/237/ojdbc11.jar

# Uncomment Oracle dialect and set JVM memory limits in catalina.sh (page 16)
RUN sed -i 's|# export JAVA_OPTS=" $JAVA_OPTS -Dhibernate.dialect=org.hibernate.dialect.Oracle10gDialect"|export JAVA_OPTS="$JAVA_OPTS -Dhibernate.dialect=org.hibernate.dialect.Oracle10gDialect"|' /home/aim141test/bin/catalina.sh

# Configure bootstrap.xml for Oracle 19c
# Leave DB_USER and DB_PASSWORD as placeholders for runtime substitution
# Assumes bootstrap.xml_oracle exists; adjust filename if different
RUN mv /home/aim141test/conf/Catalina/bootstrap.xml_oracle /home/aim141test/conf/Catalina/bootstrap.xml && \
    sed -i 's|jdbcUrl="jdbc:oracle:thin:@[^"]*"|jdbcUrl="jdbc:oracle:thin:@aim-test-db.crcgcyekq3hu.us-east-1.rds.amazonaws.com:1521/ORCL"|' /home/aim141test/conf/Catalina/bootstrap.xml && \
    sed -i 's/requireSecureAuthentication="true"/requireSecureAuthentication="false"/' /home/aim141test/conf/Catalina/bootstrap.xml

# Configure reportviewer.xml for Oracle 19c
# Leave DB_USER and DB_PASSWORD as placeholders for runtime substitution
# Assumes reportviewer.xml_oracle exists; adjust filename if different
RUN mv /home/aim141test/conf/Catalina/localhost/reportviewer.xml_oracle /home/aim141test/conf/Catalina/localhost/reportviewer.xml && \
    sed -i "s/DB_SERVER/aim-test-db.crcgcyekq3hu.us-east-1.rds.amazonaws.com/" /home/aim141test/conf/Catalina/localhost/reportviewer.xml && \
    sed -i "s/DB_NAME/ORCL/" /home/aim141test/conf/Catalina/localhost/reportviewer.xml


# Copy startup script to substitute DB_USER and DB_PASSWORD
COPY start-aim.sh /home/aim141test/bin/
RUN chmod +x /home/aim141test/bin/start-aim.sh

# Make catalina.sh executable
RUN chmod +x /home/aim141test/bin/catalina.sh

# Copy Reports folder to home dierctory
COPY Reports/ /home/aim141test/Reports/

#Add Java to path
ENV JAVA_HOME=/home/aim141test/jdk-20.0.2+9.1
ENV PATH=$JAVA_HOME/bin:$PATH

# Expose port 8080 (AiM test instance default)
EXPOSE 8080

# Start AiM using the startup script
CMD ["/home/aim141test/bin/start-aim.sh"]
