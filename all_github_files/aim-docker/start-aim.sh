#!/bin/bash
# Debug: Print environment variables
echo "DB_USER=$DB_USER"
echo "DB_PASSWORD=$DB_PASSWORD"

# Substitute DB_USER and DB_PASSWORD from environment variables
sed -i "s|DB_USER|${DB_USER}|g" /home/aim141test/conf/Catalina/bootstrap.xml
sed -i "s|DB_PASSWORD|${DB_PASSWORD}|g" /home/aim141test/conf/Catalina/bootstrap.xml
sed -i "s|DB_USER|${DB_USER}|g" /home/aim141test/conf/Catalina/localhost/reportviewer.xml
sed -i "s|DB_PASSWORD|${DB_PASSWORD}|g" /home/aim141test/conf/Catalina/localhost/reportviewer.xml

# Debug: Print updated files
echo "Updated bootstrap.xml:"
cat /home/aim141test/conf/Catalina/bootstrap.xml
echo "Updated reportviewer.xml:"
cat /home/aim141test/conf/Catalina/localhost/reportviewer.xml
#
# Start Tomcat
exec /home/aim141test/bin/catalina.sh run

