/**
 * Provides an HTTP server to run the alert state machine functionality.
 */
'use strict';

// Setting up app requirements
const express = require('express');
const Server = require('http').Server;
const bodyParser = require('body-parser');
const alertStateMachine = require('./alertStateMachine.js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Get the port from the passed in arguments
const [ node, file, portArg ] = process.argv;
const port = (portArg != null ? portArg : 5000);

app.get('/closeAllActiveAlerts', function(req, res) {
    console.log(`received: GET /closeAllActiveAlerts`);
    const messages = alertStateMachine.closeAllActiveAlerts();
    res.send(messages);
});

app.post('/inactivatePoints', function(req, res) {
    console.log(`received: POST /inactivatePoints`);
    const pointIds = extractDataFromRequest(req);
    const messages = alertStateMachine.inactivatePoints(pointIds);
    res.send(messages);
});

app.post('/alert/receipt', function(req, res) {
    console.log(`received: POST /alert/receipt`);
    const data = extractDataFromRequest(req);
    alertStateMachine.processReceivedReceipt(data.pointId, data.alertId);
    res.send('success');
});

app.post('/alertRules', function(req, res) {
    console.log(`received: POST /alertRules`);
    const alertRules = extractDataFromRequest(req);
    const messages = alertStateMachine.setAlertRules(JSON.stringify(alertRules));
    res.send(messages);
});

app.post('/alertRule', function(req, res) {
    console.log(`received: POST /alertRule`);
    const alertRule = extractDataFromRequest(req);
    const messages = alertStateMachine.setAlertRule(alertRule);
    res.send(messages);
});

app.delete('/alertRule', function(req, res) {
    console.log(`received: DELETE /alertRule`);
    const data = extractDataFromRequest(req);
    const messages = alertStateMachine.deleteAlertRule(data.id);
    res.send(messages);
});

app.get('/alertRule', function(req, res) {
    console.log(`received: GET /alertRule`);
    const data = extractDataFromRequest(req);
    const alertRule = alertStateMachine.loadAlertRuleByAlertRuleId(data.id);
    res.send(alertRule);
});

app.get('/alertRuleForPoint', function(req, res) {
    console.log(`received: GET /alertRuleForPoint`);
    const data = extractDataFromRequest(req);
    const alertRule = alertStateMachine.loadAlertRuleByPointId(data.id);
    res.send(alertRule);
});

app.get('/pointstatemap', function(req, res) {
    console.log(`received: GET /pointstatemap`);
    const data = extractDataFromRequest(req);
    const stateMap = alertStateMachine.loadAlertStateMap(data.id);
    res.send(stateMap);
});

app.post('/cleanMode', function(req, res) {
    console.log(`received: POST /cleanMode`);
    const pointIds = extractDataFromRequest(req);
    const messages = alertStateMachine.activateCleanMode(pointIds);
    res.send(messages);
});

app.post('/mqttConnectionLost', function(req, res) {
    console.log(`received: POST /mqttConnectionLost`);
    const messages = alertStateMachine.setMqttConnectionLost();
    res.send(messages);
});

app.post('/mqttConnectionRestored', function(req, res) {
    console.log(`received: POST /mqttConnectionRestored`);
    const messages = alertStateMachine.setMqttConnectionRestored();
    res.send(messages);
});

app.post('/processForAlerts', function(req, res) {
    console.log(`received: POST /processForAlerts`);
    const readings = extractDataFromRequest(req);
    
    // TODO Just for testing so current time is in the entries
    readings.forEach(reading => reading.ts = Date.now());

    const messages = alertStateMachine.processForAlerts(readings);
    res.send(messages);
});

app.post('/setLogLevel', function(req, res) {
    console.log(`received: POST /setLogLevel`);
    const level = extractDataFromRequest(req);
    const result = alertStateMachine.setLogLevel(level);
    res.send(result);
});

app.get('/ping', function(req, res) {
    console.log(`received: GET /ping`);
    res.send("running");
});

app.get('/kill', function(req, res) {
    console.log(`received: GET /kill`);
    process.exit(0);
});

function extractDataFromRequest(req) {
    let data =  (typeof req.body === 'object' ? JSON.parse(JSON.stringify(req.body)) : {});
    if (req.query) {
        Object.keys(req.query).forEach(key => data[key] = req.query[key]);
    }
    console.log(`data==${JSON.stringify(data, null, 4)}`);
    return data;
}

// Setting up the server and listener
// When address is set to 'localhost', the latency increases from milliseconds to seconds.
const server = new Server(app);
server.listen(port, () => console.log(`Server started on port ${server.address().port} at ${server.address().address}`));
