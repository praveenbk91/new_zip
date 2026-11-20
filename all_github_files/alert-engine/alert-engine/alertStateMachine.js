/**
 * This will process readings to determine if there are any alerts or events that need to be published to 
 * WatchdogEX (this does not actually do the publishing).
 * 
 * A point's state is defined in a "state map" object.  State maps are persisted to the local file system using 
 * the point's ID as the file name.  State maps are only persisted for points that are not in the "normal" state.  
 * State maps have two state attributes:
 * - state: the point's current threshold/state alert state (@see ALERT_STATE enum)
 * - hwFaultState: the point's current hardware fault alert state (@see HW_FAULT_ALERT_STATE enum)
 * The state map's ID will be used as the alert's ID if an alert is generated.
 * 
 * When a point has an active alert that either closes or clears, the state map is moved to the archive directory
 * and renamed using the state map's ID.  This is to handle received receipts.  When an alert message is published
 * the state map's receivedReceipt attribute is set to false.  When WatchdogEX processes the alert message it will
 * publish a received receipt MQTT message.  This process is to verify that the alert was received by WatchdogEX.
 * This will periodically check if the receipt has been received and if not will re-publish the message.
 */
// TODO handle reading in of any corrupted files
"use strict";
const fs = require('fs');
const os = require('os');
// Library used for compressing the user data, see https://pieroxy.net/blog/pages/lz-string/index.html
const LZString = require('./utils/lz-string.min.js');

// Get the onPrem setting from the passed in arguments
const [ node, file, portArg, inDocker ] = process.argv;
const IN_DOCKER = (inDocker != null && inDocker === 'true' ? true : false);

// Directory where data is persisted.  If not running on 'win32' then this is assumed to be a Greyhound controller.
var PERSISTENCE_DIRECTORY =  IN_DOCKER
    ? '/app/WDEX/alertengine/data'
    : os.platform() === 'win32' 
        ? './alertdetection' 
        : '/var/apollo/data/apps/greyhound/alertdetection';
// Directory where the alert rules are persisted.
var ALERT_RULES_DIRECTORY = `${PERSISTENCE_DIRECTORY}/alertRules`;
// Directory where the alert state maps are persisted.
var ALERT_STATE_MAPS_DIRECTORY = `${PERSISTENCE_DIRECTORY}/alertStateMaps`;
// Directory where the inactive (closed/cleared) alert state maps that are awaiting received receipts are persisted.
var ALERT_STATE_MAPS_INACTIVE_DIRECTORY = `${ALERT_STATE_MAPS_DIRECTORY}/inactive`;
// File containing the point to alert rule mappings.
var ALERT_RULES_MAPPING_FILE = `${ALERT_RULES_DIRECTORY}/mappings.json`;
// File containing the point to alert rule mappings.
var HW_ALERT_RULES_MAPPING_FILE = `${ALERT_RULES_DIRECTORY}/mappingsHardwareFaults.json`;
// Directory where the alert rules are persisted.
var MQTT_CONNECTION_OFFLINE_FILE = `${PERSISTENCE_DIRECTORY}/mqttConnectionOffline`;

/** "Enum" to represent to represent the types of point groupings. */
const PointGroup = { ANALOG: 'ANALOG', DIGITAL: 'DIGITAL', LIGHTING: 'LIGHTING' };
Object.freeze(PointGroup);

/** "Enum" to represent to represent the possible events. */
const Event = { 
    // Event when the warning alert condition is detected but the rule has an alert delay
    WARNING_ALERT_DELAYING: 'WARNING_ALERT_DELAYING',   
    // Event when the critical alert condition is detected but the rule has an alert delay
    CRITICAL_ALERT_DELAYING: 'CRITICAL_ALERT_DELAYING',   
    // Event when an alert condition clears while the alert is in the delaying state
    DELAY_CANCELLED: 'DELAY_CANCELLED', 
    // Event when an alert condition clears but the rule has a clear delay
    CLEAR_DELAYING: 'CLEAR_DELAYING', 
    // Event when an alert condition returns while the alert is in the clear delay state
    CLEAR_CANCELLED: 'CLEAR_CANCELLED',
    // Event when a HW fault condition clears but the rule has a clear delay
    HW_FAULT_CLEARING: 'HW_FAULT_CLEARING',
    // Event when a HW fault condition clears while the in the HW fault delaying state
    HW_FAULT_CLEARED: 'HW_FAULT_CLEARED',
    // Event when a HW fault is detected but the rule has an alert delay
    HW_FAULT_DELAYING: 'HW_FAULT_DELAYING',
    // Event when a state map is closed when in alert delay because the alert rule has changed
    DELAY_CANCELLED_RULE_CHANGED: 'DELAY_CANCELLED_RULE_CHANGED',
    // Event when a state map is closed when in alert delay because clean mode has been activated
    DELAY_CANCELLED_CLEAN_MODE_ACTIVATED: 'DELAY_CANCELLED_CLEAN_MODE_ACTIVATED',
    // Event when a state map is closed when the alert engine has restarted
    DELAY_CANCELLED_ALERT_ENGINE_RESTARTED: 'DELAY_CANCELLED_ALERT_ENGINE_RESTARTED',
    // Event when a state map is closed when a point has been inactivated
    DELAY_CANCELLED_POINT_INACTIVATED: 'DELAY_CANCELLED_POINT_INACTIVATED'
};
Object.freeze(Event);

/** "Enum" to represent to represent the types of notifications. 
 * Anything added to this must also be covered in AlarmNotification.java in the notification service.
 */
const NotificationType = {
    /** Indicates that the state machine is active for hardware fault, any delay has expired. */
	HW_FAULT_ACTIVE: 'HARDWARE_FAULT_ACTIVE',
	/** Indicates that the state machine is active, any delay has expired. */
	ACTIVE: 'ACTIVE',
	/** Indicates that the state machine is cleared and is back to normal, any clear delay has expired. */
	CLEARED: 'CLEARED',
	/** Indicates that the state machine has been closed because the alert rule has been modified. */
    CLOSED__THRESHOLD_ALERT: 'CLOSED',  
	/** Indicates that the state machine has been closed because of a hardware fault. */
	CLOSED__HW_FAULT: 'HARDWARE_FAULT_CLOSED',
	/** Closed due to clean mode activation. */
	CLOSED__CLEAN_MODE_ACTIVATED: 'CLEAN_MODE_CLOSED',
	/** Closed due to alert rule being deleted. */
	CLOSED__RULE_DELETED: 'CLOSED__RULE_DELETED',
	/** Closed due to alert engine restarting. */
	CLOSED__ALERT_ENGINE_RESTARTED: 'ALERT_ENGINE_RESTARTED',
	/** Indicates that the state machine has escalated from the warning to critical level. */
	REACHED_CRITICAL: 'REACHED_CRITICAL'
};
Object.freeze(NotificationType);

/** "Enum" to represent to represent the alert levels when evaluating the trend to an alert rule. */
const AlertLevel = {
    NONE: 'NONE',
    SENSOR_FAULT: 'SENSOR_FAULT',
    COMM_LOSS: 'COMM_LOSS',
	WARNING: 'WARNING',
	CRITICAL: 'CRITICAL'
};
Object.freeze(AlertLevel);

/** "Enum" to represent to represent the alert condition when evaluating the trend to an alert rule. */
const AlertCondition = {
    /** When an analog point's value falls below the low conditions. */
	LOW: 'LOW',
	/** When an analog point's value exceeds the high conditions. */
	HIGH: 'HIGH',
	/** When a digital point matches a trigger. */
	STATE: 'STATE'
};
Object.freeze(AlertCondition);

/** Mapping of state names to state indexes. */
const LIGHT_STATE_MAP = {
	'state.lights.singleLevel.off': 0,
	'state.lights.singleLevel.on': 1,
	'state.lights.dualLevel.off': 0,
	'state.lights.dualLevel.on': 1,
	'state.lights.dualLevel.onHigh': 2,
    'state.lighting.control.off': 0,
    'state.lighting.control.off.override': 1,
    'state.lighting.control.on': 2,
    'state.lighting.control.on.override': 3,
    'state.lighting.control.night': 4,
    'state.lighting.control.night.override': 5,
    'state.lighting.control.onhigh.override': 6,
    'state.lighting.control.hardware.ok': 7,
    'state.lighting.control.hardware.relayFailure': 8,
    'state.lighting.control.hardware.hardwareFault': 9
};
Object.freeze(LIGHT_STATE_MAP);

/** "Enum" for the alert states used for the StateMap.state attribute. */
const ALERT_STATE = {
    NORMAL: 'NORMAL',
    WARNING_DELAYING: 'WARNING_DELAYING',
    WARNING_ACTIVE: 'WARNING_ACTIVE', 
    WARNING_CLEARING: 'WARNING_CLEARING',
    CRITICAL_DELAYING: 'CRITICAL_DELAYING',
    CRITICAL_REACHED_DELAYING: 'CRITICAL_REACHED_DELAYING',
    CRITICAL_ACTIVE: 'CRITICAL_ACTIVE',
    CRITICAL_CLEARING: 'CRITICAL_CLEARING'
};
Object.freeze(ALERT_STATE);

/** "Enum" for the hardware fault alert states used for the StateMap.hwFaultState attribute. */
const HW_FAULT_ALERT_STATE = {
	NORMAL: 'NORMAL',
    SENSOR_FAULT_DELAYING: 'SENSOR_FAULT_DELAYING',
    SENSOR_FAULT_ACTIVE: 'SENSOR_FAULT_ACTIVE',
    SENSOR_FAULT_CLEARING: 'SENSOR_FAULT_CLEARING',
    COMM_LOSS_DELAYING: 'COMM_LOSS_DELAYING',
    COMM_LOSS_ACTIVE: 'COMM_LOSS_ACTIVE',
    COMM_LOSS_CLEARING: 'COMM_LOSS_CLEARING'
};
Object.freeze(HW_FAULT_ALERT_STATE);

// Log levels is order of hierarchy.
const LOG_LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
Object.freeze(LOG_LEVELS);

// Cache of the contents of ALERT_RULES_MAPPING_FILE.  The key is a point ID; value is the alert rule ID.
let alertRuleMappings;
// Cache of the contents of HW_ALERT_RULES_MAPPING_FILE.  The key is a point ID; value is on object with the hardware fault alert rule's ID and hold time.
let hardwareAlertRuleMappings;
// Cache to hold a local copy of the alert rules to reduce reads to disk.
const alertRuleCache = {};

// The at which to log.
let logLevel = LOG_LEVELS[0];

// Set the log level.
module.exports.setLogLevel = (level) => {
    if (LOG_LEVELS.includes(level)) {
        logLevel = level;
        return true;
    } else {
        log('ERROR', `Invalid log level: ${level}`);
        return false;
    }
};

module.exports.setDataDirectory = (dir) => {
    PERSISTENCE_DIRECTORY = dir;
    log('INFO', `Data directory set to ${PERSISTENCE_DIRECTORY}`);
    ALERT_RULES_DIRECTORY = `${PERSISTENCE_DIRECTORY}/alertRules`;
    ALERT_STATE_MAPS_DIRECTORY = `${PERSISTENCE_DIRECTORY}/alertStateMaps`;
    ALERT_STATE_MAPS_INACTIVE_DIRECTORY = `${ALERT_STATE_MAPS_DIRECTORY}/inactive`;
    ALERT_RULES_MAPPING_FILE = `${ALERT_RULES_DIRECTORY}/mappings.json`;
    HW_ALERT_RULES_MAPPING_FILE = `${ALERT_RULES_DIRECTORY}/mappingsHardwareFaults.json`;
    MQTT_CONNECTION_OFFLINE_FILE = `${PERSISTENCE_DIRECTORY}/mqttConnectionOffline`;
    initialize();
};

/**
 * This will close the active alerts and any state maps that are delaying for the provided point
 * IDs.  
 * @param {array} pointIdsToClose Array of the point IDs for which active alers should be closed.
 * @param {string} alertCloseReason The NotificationType for why the alerts are being closed. If undefined, a close alert
 * message will not be generated.
 * @param {string} eventCloseReason The reason for why the events are being cancelled. If undefined, a cancelled event will
 * not be generated. 
 * @return Array of alert and event messages to publish to WatchdogEX.
 */
module.exports.closeActiveAlerts = (pointIdsToClose, alertCloseReason, eventCloseReason) => {
    const messagesToPublish = { alerts: [], events: [] };
    pointIdsToClose.forEach(pointId => {
        const alertStateMap = exports.loadAlertStateMap(pointId);
        if (alertStateMap == null || !alertStateMap.active) return;
        log('DEBUG', `Found an active alert state map for point ${alertStateMap.pointId}; closing this alert...`);
        alertStateMap.active = false;
        alertStateMap.receivedReceipt = false;  // reset to keep track if closed message receives a receipt
        persistAlertStateMap(alertStateMap);  // this will move it to the inactive directory
        // If in delaying only need to send an event, other wise send an alert closed message
        if (alertStateMap.started == null) {
            if (eventCloseReason != undefined) {
                const reading = { customer: alertStateMap.triggeredValue.customer, id: pointId };
                messagesToPublish.events.push(generateEvent(reading, eventCloseReason, alertStateMap.id));
            }
        } else {
            if (alertCloseReason != undefined) {
                const alertRule = exports.loadAlertRuleByAlertRuleId(alertStateMap.alertSetupId);
                messagesToPublish.alerts.push(generateAlert(alertStateMap, alertCloseReason, (alertRule == null ? null : alertRule.pointGroup)));
            }
        }
    });
    return messagesToPublish;
};

/**
 * Inform the alert engine about points that have been inactivated. This will close any active alerts
 * for these points and cancel any state maps that are delaying.
 * 
 * @param {array} pointIds Array of IDs of points that have been inactivated.
 * @return Array of alert and event messages to publish to WatchdogEX.
 */
module.exports.inactivatePoints = (pointIds) => {
    // Set alert close reason to undefined. A close alert message does not need to be generated 
    // here as the alert will be closed in AWS when the point is inactivated.
    const alertCloseReason = undefined;
    return exports.closeActiveAlerts(pointIds, alertCloseReason, Event.DELAY_CANCELLED_POINT_INACTIVATED);
};

/**
 * This will close all active alerts and any state maps that are delaying. This should be
 * called whenever the alert engine is restarted, e.g. controller is power cycled. This must be
 * performed because when the controller is powered off no trend data will be published to 
 * WatchdogEX. If the controller is powered off long enough, WatchdogEX will generate a comm 
 * loss alert. When the controller is eventually restarted it will publish a live value that will
 * clear the comm loss alert. If the point is actually still in the alert condition, the engine 
 * will think that WatchdogEX is already aware of the alert and will not publish an alert message. 
 * Therefore, WatchdogEX will display the point as operating in the normal condition and will not 
 * notify users of the actual condition.
 * 
 * This should only be called when the alert engine is first started.
 * 
 * @return Array of alert and event messages to publish to WatchdogEX.
 */
module.exports.closeAllActiveAlerts = () => {
    // Get all of the point IDs that are part of an alert rule.
    const allPointIds = [];
    Object.keys(alertRuleMappings).forEach(pointId => allPointIds.push(pointId));
    Object.keys(hardwareAlertRuleMappings).forEach(pointId => {
        if (allPointIds.indexOf(pointId) < 0) allPointIds.push(pointId);
    });
    return exports.closeActiveAlerts(allPointIds, NotificationType.CLOSED__ALERT_ENGINE_RESTARTED, Event.DELAY_CANCELLED_ALERT_ENGINE_RESTARTED);
};

/**
 * Set all the alert rules.  This is called when a device update is performed.  This is expecting
 * alertRules to contain all of the alert rules for the customer, e.g. during a device update.
 */
module.exports.setAlertRules = (alertRules) => {
    alertRules = JSON.parse(alertRules);
    log('INFO', `Setting alert rules: ${JSON.stringify(alertRules, null, 4)}`);
    if (!Array.isArray(alertRules)) {
        log('WARN', 'The alert rules have been compressed, decompressing...');
        alertRules = JSON.parse(LZString.decompressFromBase64(alertRules.rules));
        log('DEBUG', `alertRulesSet, decompressed==${JSON.stringify(alertRules)}`);
    }
    const messagesToPublish = [];
    const existingAlertRuleIds = [];
    fs.readdirSync(ALERT_RULES_DIRECTORY).forEach(filename => {
        if (filename === 'mappings.json' || filename === 'mappingsHardwareFaults.json') return;
        existingAlertRuleIds.push(filename);
    });
    alertRules.forEach(next => {
        const alertRule = JSON.parse(JSON.stringify(next.properties));
        alertRule.id = next.id;
        alertRule.pointIds = next.points;
        log('INFO', `Updating alert rule ${alertRule.id}`);
        exports.setAlertRule(alertRule, false);
        const index = existingAlertRuleIds.indexOf(alertRule.id);
        if (index >= 0) existingAlertRuleIds.splice(index, 1);
    });  

    // Delete and close any alert rules that no longer exist.
    existingAlertRuleIds.forEach(ruleId => {
        log('INFO', `Deleting alert rule ${ruleId}`);
        messagesToPublish.push(...exports.deleteAlertRule(ruleId))
    });
    return messagesToPublish;
};

/**
 * Call this whenever an alert rule has been modified.  This will:
 * - close any alert state maps that exist for points in the original alert rule
 * - generate closed alert messages for these state maps
 * - persist the new alert rule
 * - update the point to alert rule mappings
 * 
 * @param {*} alertRule 
 * @returns The list of alert closed messages that need to be published to WatchdogEX.
 */
module.exports.setAlertRule = (alertRule, closeAlerts = true) => {
    log('INFO', `setting alert rule: ${JSON.stringify(alertRule, null, 4)}`);
    
    // First delete the alert rule.  This will close any active state maps that are associated with
    // the alert rule.  This will return any messages that need to be published back to WatchdogEX.
    const messagesToPublish = exports.deleteAlertRule(alertRule.id, closeAlerts, true);        
    // Set the point group type in the alert rule
    if (alertRule.hasOwnProperty('holdTime')) {
        // This is a hardware fault alert rule, doesn't have concept of pointGroup. 
        // update mappings    
        alertRule.pointIds.forEach(pointId => hardwareAlertRuleMappings[pointId] = { id: alertRule.id, holdTime: alertRule.holdTime });
        persistPointToHardwareAlertRuleMappings();
    } else {
        if (alertRule.hasOwnProperty('highCriticalThreshold')) {
            alertRule.pointGroup = PointGroup.ANALOG;
        } else if (alertRule.hasOwnProperty('triggers')) {
            alertRule.pointGroup = PointGroup.LIGHTING;
        } else {
            alertRule.pointGroup = PointGroup.DIGITAL;
        }    
        // update mappings    
        alertRule.pointIds.forEach(pointId => alertRuleMappings[pointId] = alertRule.id);
        persistPointToAlertRuleMappings();
    }
    // save to file system
    persistAlertRule(alertRule);
    // Return the messages that need to be published.
    return messagesToPublish;
};

/**
 * Delete an alert rule.  This will:
 *      - remove the alert rule from the cache and the file system
 *      - close any active alert state machines associated with the alert rule's points
 *      - update the point to alert rule mappings
 *      - generate alert closed messages
 * @param {*} alertRuleId 
 * @param closeAlerts
 * @param isForAlertUpdate Optional Boolean - indicates if the alert rule is being deleted because 
 * the rule is really being updated. Default is false.
 * @returns 
 */
module.exports.deleteAlertRule = (alertRuleId, closeAlerts = true, isForAlertUpdate = false) => {
    // Load the rule from cache or file system.
    let alertRule = exports.loadAlertRuleByAlertRuleId(alertRuleId);
    if (alertRule == null) return [];
    log('INFO', `deleting alert rule: ${JSON.stringify(alertRule, null, 4)}`);
    // Remove from cache and file system
    delete alertRuleCache[alertRule.id];
    let filepath = `${ALERT_RULES_DIRECTORY}/${alertRule.id}.json`;
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);    
    if (!closeAlerts) return [];
    // Close the state maps
    const messagesToPublish = [];    
    log('INFO', `Closing active alert state maps associated with the alert rule's points...`);
    alertRule.pointIds.forEach(pointId => {
        if (alertRule.hasOwnProperty("holdTime")) { 
            delete hardwareAlertRuleMappings[pointId];
        } else {
            delete alertRuleMappings[pointId];
        }
        const alertStateMap = exports.loadAlertStateMap(pointId);
        if (alertStateMap == null || !alertStateMap.active || alertStateMap.alertSetupId !== alertRuleId) return;
        log('INFO', `Found an active alert state map for alert rule ${alertRuleId}; point ${alertStateMap.pointId}; closing this alert...`);
        alertStateMap.active = false;
        alertStateMap.receivedReceipt = false;  // reset to keep track if closed message receives a receipt
        persistAlertStateMap(alertStateMap);  // this will move it to the inactive directory
        // If in delaying only need to send an event, other wise send an alert closed message
        if (alertStateMap.started == null) {
            const reading = { customer: alertStateMap.triggeredValue.customer, id: alertStateMap.pointId };
            messagesToPublish.push(generateEvent(reading, Event.DELAY_CANCELLED_RULE_CHANGED, alertStateMap.id));
        } else {
            const notificationType = (isForAlertUpdate ? NotificationType.CLOSED__THRESHOLD_ALERT : NotificationType.CLOSED__RULE_DELETED);
            messagesToPublish.push(generateAlert(alertStateMap, notificationType, (alertRule == null ? null : alertRule.pointGroup)));
        }
    });
    if (alertRule.hasOwnProperty("holdTime")) {
        persistPointToHardwareAlertRuleMappings();
    } else {
        persistPointToAlertRuleMappings();
    }
    return messagesToPublish;
};

/**
 * Activate clean mode.  This will:
 *      - Get any state map for the affected points.
 *      - Close any active state maps.
 *      - Send a message to WatchdogEX that the alert has been closed from the clean mode activation.
 * @param {string[]} pointIds Array of point identifiers.
 * @param {boolean} [closeAlerts=true] Optional boolean to indicate if alerts should be closed, default is true.
 * @returns Any alert closed messages.
 */
module.exports.activateCleanMode = (pointIds, closeAlerts = true) => {
    if (!closeAlerts) return [];
    // Close the state maps
    const messagesToPublish = [];    
    log('INFO', `Closing active alert state maps due to clean mode activation...`);    
    pointIds.forEach(pointId => {
        const alertStateMap = exports.loadAlertStateMap(pointId);
        if (alertStateMap == null || !alertStateMap.active) return;
        log('INFO', `Found an active alert state map for point ${pointId}, closing...`);
        alertStateMap.active = false;
        alertStateMap.receivedReceipt = false;  // reset to keep track if closed message receives a receipt
        persistAlertStateMap(alertStateMap);  // this will move it to the inactive directory
        // If in delaying only need to send an event, otherwise send an alert closed message
        if (alertStateMap.started == null) {
            const reading = { customer: alertStateMap.triggeredValue.customer, id: alertStateMap.pointId };
            messagesToPublish.push(generateEvent(reading, Event.DELAY_CANCELLED_CLEAN_MODE_ACTIVATED, alertStateMap.id));
        } else {
            messagesToPublish.push(generateAlert(alertStateMap, NotificationType.CLOSED__CLEAN_MODE_ACTIVATED, null));
        }
    });
    return messagesToPublish;
};

/**
 * This should be called when the bridge/controller detect that the connection has been lost with the 
 * WatchdogEX MQTT broker.  This will close any active alerts and return the closed messages so that the
 * bridge/controller can add these messages to the data that will need to be recovered when the connection
 * to the broker is restored.
 * 
 * This will cause the alert detector to stop processing any trend data, see function processForAlerts.
 */
module.exports.setMqttConnectionLost = () => {
    const messages = { alerts: [], events: [] };
    if (fs.existsSync(MQTT_CONNECTION_OFFLINE_FILE)) {
        log('DEBUG', `MQTT connection lost status has already processed`);
        return messages;
    }

    log('INFO', `MQTT connection lost, closing all active alerts`);
    fs.closeSync(fs.openSync(MQTT_CONNECTION_OFFLINE_FILE, 'w'));
    
    fs.readdirSync(ALERT_STATE_MAPS_DIRECTORY).forEach(filename => {
        if (filename === 'inactive') return log('DEBUG', `Ignoring '${filename}'`);
        const pointId = filename.replace('.json', '');
        log('DEBUG', `Processing: filename=='${filename}'; pointId=='${pointId}'`);
        const alertStateMap = exports.loadAlertStateMap(pointId);
        log('DEBUG', `state map==${JSON.stringify(alertStateMap, null, 4)}`);
        if (alertStateMap == null) return log('INFO', `state map does not exist for point '${pointId}'`);
        if (!alertStateMap.active) return log('INFO', `state map is not active for point '${pointId}'`);
        log('DEBUG', `state map is active for point '${pointId}'`);
        switch (alertStateMap.state) {
            case ALERT_STATE.WARNING_DELAYING:
                log('INFO', `state is ${alertStateMap.state}; generating delay cancelled event message`);
                messages.events.push(generateEvent(alertStateMap.lastPointValue, Event.DELAY_CANCELLED, alertStateMap.id));
                break;
            case ALERT_STATE.WARNING_ACTIVE:
            case ALERT_STATE.CRITICAL_ACTIVE:
            case ALERT_STATE.WARNING_CLEARING:
            case ALERT_STATE.CRITICAL_CLEARING:
                log('INFO', `state is ${alertStateMap.state}; generating alert closed message`);
                const alertRule = this.loadAlertRuleByAlertRuleId(alertStateMap.alertSetupId);
                messages.alerts.push(generateAlert(alertStateMap, NotificationType.CLOSED__THRESHOLD_ALERT, alertRule.pointGroup, { closedMessage: 'alert.closed.due.to.aws.comm.loss' }));
                break;
            case ALERT_STATE.NORMAL: 
                log('DEBUG', `state is ${alertStateMap.state}; checking hardware fault state`);
                switch (alertStateMap.hwFaultState) {                    
                    case HW_FAULT_ALERT_STATE.SENSOR_FAULT_DELAYING:
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_DELAYING:
                            log('DEBUG', `hardware fault state is ${alertStateMap.hwFaultState}; generating delay cancelled event message`);
                            messages.events.push(generateEvent(alertStateMap.lastPointValue, Event.DELAY_CANCELLED, alertStateMap.id));
                            break;
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_ACTIVE:
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_CLEARING:
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_ACTIVE:
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_CLEARING:
                            log('DEBUG', `hardware fault state is ${alertStateMap.hwFaultState}; generating alert closed message`);
                            messages.alerts.push(generateAlert(alertStateMap, NotificationType.CLOSED__HW_FAULT, null, { closedMessage: 'alert.closed.due.to.aws.comm.loss' }));
                            break;
                        case HW_FAULT_ALERT_STATE.NORMAL: 
                            log('DEBUG', `hardware fault state is ${alertStateMap.hwFaultState}; no messages to generate`);
                            break;
                        default:
                            log('DEBUG', `hardware fault state is ${alertStateMap.hwFaultState}; unknown state, ignoring`);
                            break;
                        }
                break;
            default:
                log('DEBUG', `state is ${alertStateMap.state}; unknown state, ignoring`);
                break;
        }
        deleteAlertStateMap(alertStateMap);
    });
    return messages;
};

/**
 * Called by the bridge/controller when the connection to the MQTT broker has been established or
 * restored.  
 */
module.exports.setMqttConnectionRestored = () => {
    if (fs.existsSync(MQTT_CONNECTION_OFFLINE_FILE)) {
        log('INFO', `MQTT connection restored, generating alert messages`);    
        fs.unlinkSync(MQTT_CONNECTION_OFFLINE_FILE);
    }
    return { alerts: [], events: [] };

    // FUTURE we may want to detect alerts during comm loss.  
    // const messages = { alerts: [], events: [] };
    // if (!fs.existsSync(MQTT_CONNECTION_OFFLINE_FILE)) {
    //     log('INFO', `MQTT connection restored status has already been processed`);
    //     return messages;
    // }

    // log('INFO', `MQTT connection restored, generating alert messages`);    
    // fs.unlinkSync(MQTT_CONNECTION_OFFLINE_FILE);

    // fs.readdirSync(ALERT_STATE_MAPS_DIRECTORY).forEach(filename => {
    //     if (filename === 'inactive') return log('INFO', `Ignoring '${filename}'`);
    //     const pointId = filename.replace('.json', '');
    //     log('INFO', `Processing: filename=='${filename}'; pointId=='${pointId}'`);
    //     const alertStateMap = exports.loadAlertStateMap(pointId);
    //     log('INFO', `state map==${JSON.stringify(alertStateMap, null, 4)}`);
    //     if (!alertStateMap.active) return log('INFO', `state map is not active for point '${pointId}'`);
    //     log('INFO', `state map is active for point '${pointId}'`);
    //     switch (alertStateMap.state) {
    //         case ALERT_STATE.WARNING_DELAYING:
    //         case ALERT_STATE.CRITICAL_DELAYING:
    //             log('INFO', `state is ${alertStateMap.state}; alert message not needed`);
    //             break;
    //         case ALERT_STATE.WARNING_ACTIVE:
    //         case ALERT_STATE.CRITICAL_ACTIVE:
    //         case ALERT_STATE.WARNING_CLEARING:
    //         case ALERT_STATE.CRITICAL_CLEARING:
    //             log('INFO', `state is ${alertStateMap.state}; generating alert closed message`);
    //             const alertRule = this.loadAlertRuleByAlertRuleId(alertStateMap.alertSetupId);
    //             messages.alerts.push(generateAlert(alertStateMap, NotificationType.ACTIVE, alertRule.pointGroup, { isRecovered: true }));
    //             break;
    //         case ALERT_STATE.NORMAL: 
    //             log('INFO', `state is ${alertStateMap.state}; checking hardware fault state`);
    //             switch (alertStateMap.hwFaultState) {                    
    //                 case HW_FAULT_ALERT_STATE.SENSOR_FAULT_DELAYING:
    //                     case HW_FAULT_ALERT_STATE.COMM_LOSS_DELAYING:
    //                         log('INFO', `hardware fault state is ${alertStateMap.hwFaultState}; alert message not needed`);
    //                         break;
    //                     case HW_FAULT_ALERT_STATE.SENSOR_FAULT_ACTIVE:
    //                     case HW_FAULT_ALERT_STATE.COMM_LOSS_ACTIVE: 
    //                     case HW_FAULT_ALERT_STATE.SENSOR_FAULT_CLEARING:
    //                     case HW_FAULT_ALERT_STATE.COMM_LOSS_CLEARING:
    //                         log('INFO', `hardware fault state is ${alertStateMap.hwFaultState}; generating alert closed message`);
    //                         messages.alerts.push(generateAlert(alertStateMap, NotificationType.HW_FAULT_ACTIVE, null, { isRecovered: true }));
    //                         break;
    //                     case HW_FAULT_ALERT_STATE.NORMAL: 
    //                         log('INFO', `hardware fault state is ${alertStateMap.hwFaultState}; alert message not needed`);
    //                         break;
    //                     default:
    //                         log('INFO', `hardware fault state is ${alertStateMap.hwFaultState}; unknown state, ignoring`);
    //                         break;
    //                     }
    //             break;
    //         default:
    //             log('INFO', `state is ${alertStateMap.state}; unknown state, ignoring`);
    //             break;
    //     }
    // });
    // return messages;
};

/**
 * Get the alert rule for a point. 
 *  
 * @param {string} pointId The unique identifier for a point.
 * @returns An object representing the alert rule or null if an alert rule does not exist for the point.
 */
module.exports.loadAlertRuleByPointId = (pointId) => {
    log('DEBUG', `Getting alert rule for point ${pointId}`);
    if (!alertRuleMappings.hasOwnProperty(pointId)) return null;
    const alertRuleId = alertRuleMappings[pointId];
    log('DEBUG', `Alert rule exists for ${pointId}; alert rule ID == ${alertRuleId}`);
    return exports.loadAlertRuleByAlertRuleId(alertRuleId);
};

/**
 * Get the alert rule by alert rule ID.
 * 
 * @param {string} alertRuleId The unique identifier for an alert rule.
 * @returns An object representing the alert rule or null if an alert rule does not exist for the point.
 */
module.exports.loadAlertRuleByAlertRuleId = (alertRuleId) => {
    log('DEBUG', `Getting alert rule ${alertRuleId}`);
    if (alertRuleCache.hasOwnProperty(alertRuleId)) {
        log('DEBUG', `Found alert rule in cache`);
        return alertRuleCache[alertRuleId];
    }
    log('DEBUG', `Alert rule not in cache, loading from file system`);
    return parseJsonFile(`${ALERT_RULES_DIRECTORY}/${alertRuleId}.json`);
};

/**
 * Process the reading to determine if there are any alerts or events that need to be published
 * to WatchdogEX.
 * 
 * @param {object[]} reading A point's reading.
 */
module.exports.processForAlerts = (readings) => {
    const messages = { alerts: [], events: [] };    
    if (fs.existsSync(MQTT_CONNECTION_OFFLINE_FILE)) {
        log('DEBUG', `MQTT connection status is offline; ignoring readings.`);
        return messages;
    }

    log('DEBUG', `Processing ${readings.length} readings for alerts/events.`);
    readings.forEach(reading => {
        // The reading might specify the customer's ID with an attribute of 'customer' or
        // 'customerId'.  To make sure this is handled correctly from here on this will 
        // convert 'customerId' to 'customer'.
        if (reading.hasOwnProperty('customerId')) { 
            reading.customer = reading.customerId;
        }
        log('DEBUG', `Processing reading: ${JSON.stringify(reading, null, 4)}`);
        if (reading.hasOwnProperty('panelFlushing') && reading.panelFlushing) {
            // TODO Should this close any active alerts?
            log('DEBUG', `[${reading.id}] Ignoring reading, panel is flushing`);            
            return;
        }
        if (reading.hasOwnProperty('cleanMode') && reading.cleanMode) {
            // TODO close any active alerts
            log('DEBUG', `[${reading.id}] Ignoring reading, point is in clean mode.`);            
            return;
        }
        // Get the point's alert rules
        const hwFaultAlertRule = hardwareAlertRuleMappings[reading.id];
        const alertRule = exports.loadAlertRuleByPointId(reading.id);
        if (hwFaultAlertRule == null && alertRule == null) {
            log('DEBUG', `[${reading.id}] No alerting rules exist for this point, ignoring.`);
            return;
        }
        // evaluate the reading for an alert condition
        const alertCondition = evaluateAlertCondition(reading, alertRule);
        log('DEBUG', `[${reading.id}] Current alert condition: ${JSON.stringify(alertCondition)}`);

        const isInHwAlert = [ 'SENSOR_FAULT', 'COMM_LOSS' ].includes(alertCondition.level);

        // The reading can be ignored if:
        //     - the current reading indicates a HW fault 
        //     - and the point does not have a HW fault rule
        if (isInHwAlert && hwFaultAlertRule == null) {
            log('DEBUG', `[${reading.id}] No hardware fault alert rules exist for this point, ignoring.`);
            return;
        }

        // Get the state map for the point
        let stateMap = exports.loadAlertStateMap(reading.id);
        
        // The reading can be ignored if:
        //     - the current reading does NOT indicate a HW fault 
        //     - and the point was NOT previously in a HW fault condition 
        //     - and the point does NOT have a threshold alert rule
        // const hwFaultState = (stateMap ? stateMap.hwFaultState : HW_FAULT_ALERT_STATE.NORMAL);
        const wasInHwAlert = (stateMap ? stateMap.hwFaultState !== HW_FAULT_ALERT_STATE.NORMAL : false);
        if (!isInHwAlert && !wasInHwAlert && alertRule == null) {
            log('DEBUG', `[${reading.id}] Point was and is not in a HW fault condition and no threshold alert rule exists, ignoring.`);
            return;
        }

        // If a state map doesn't yet exist for the point, build one.
        if (stateMap == null) {
            if (isInHwAlert) {
                stateMap = buildNewStateMap(reading.id, reading, alertCondition, hwFaultAlertRule);
            } else {
                stateMap = buildNewStateMap(reading.id, reading, alertCondition, alertRule);
            }
        }
        stateMap.lastPointValue = JSON.parse(JSON.stringify(reading));
        processReading(reading, alertRule, hwFaultAlertRule, stateMap, alertCondition, messages);
    });
    return messages;
};

/**
 * Process a received receipt from WatchdogEX.  
 * 
 * @param {string} pointId The unique ID of a point.
 * @param {string} alertId The unique ID of an alert.
 */
module.exports.processReceivedReceipt = (pointId, alertId) => {
    let stateMap = exports.loadAlertStateMap(pointId);
    if (stateMap == null) {
        // State map will be null if it is not active.  In this case it can now be deleted from the archive.
        deleteAlertStateMapFromArchive(alertId);
    } else {
        stateMap.receivedReceipt = true;
        persistAlertStateMap(stateMap);
    }
};

/**
 * Get the alert state map for a point.
 * @param {string} pointId The unique identifier for a point.
 * @returns An object representing the alert state map or null if one does not exist.
 */
module.exports.loadAlertStateMap = (pointId) => {
    log('DEBUG', `[${pointId}] Loading alert state map for point.`);
    let stateMap = parseJsonFile(`${ALERT_STATE_MAPS_DIRECTORY}/${pointId}.json`);
    if (stateMap != null) {
        if (stateMap.active) {
            log('DEBUG', `[${pointId}] Found a state map on file system: ${JSON.stringify(stateMap, null, 4)}`);
            return stateMap;
        } 
        log('DEBUG', `[${pointId}] Found a state map on file system but it is not active, deleting.`);
        deleteAlertStateMap(stateMap);
    } else {
        log('DEBUG', `[${pointId}] No state map found for the point.`);
    }
    return null;
};

/**
 * The process function is used to evaluate the current reading for a point and determine what needs to happen 
 * next, e.g. publish an alert or event message, based on the alert rules for the point.
 * 
 * @param {object} reading The current reading for a point.
 * @param {object} alertRule The alert rule for the point.
 * @param {object} hwAlertRule The hardware fault alert rule for the point.
 * @param {object} stateMap The point's current alert state map.
 * @param {AlertCondition} alertCondition The alert condition for the current reading and the alert rule.
 * @param {object} messages Object to add any messages that need to be published to AWS.
 */
// TODO Consider refactoring this from a giant multi-level switch function.
// TODO If point only has HW rule and no threshold rule, how do we determine PointGroup for sending alert messages?
const processReading = (reading, alertRule, hwAlertRule, stateMap, alertCondition, messages) => {
    log('DEBUG', `[${reading.id}] Process: alertLevel==${alertCondition.level}; state==${stateMap.state}; hwFaultState==${stateMap.hwFaultState}; delayExpired==${reading.ts >= stateMap.delayTime}`);
    switch (alertCondition.level) {
        case AlertLevel.NONE: {
            // What happens next depends on the point current alert state
            switch (stateMap.state) {
                case ALERT_STATE.NORMAL: {
                    // When the alert state is NORMAL, there could be a hardware fault state.  What happens next depends on 
                    // the current hardware fault state.
                    switch (stateMap.hwFaultState) {
                        case HW_FAULT_ALERT_STATE.NORMAL: {
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_DELAYING:
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_DELAYING: {
                            if (reading.ts >= stateMap.delayTime) {
                                log('DEBUG', `[${reading.id}] HW fault has cleared before delay expired; deleting state map; sending event message (${Event.HW_FAULT_CLEARED})`);
                                deleteAlertStateMap(stateMap);
                                messages.events.push(generateEvent(reading, Event.HW_FAULT_CLEARED, stateMap.id));
                            }
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_ACTIVE:
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_ACTIVE: {
                            stateMap.hwFaultState = (stateMap.hwFaultState === HW_FAULT_ALERT_STATE.COMM_LOSS_ACTIVE ? HW_FAULT_ALERT_STATE.COMM_LOSS_CLEARING : HW_FAULT_ALERT_STATE.SENSOR_FAULT_CLEARING);
                            log('DEBUG', `[${reading.id}] HW fault is clearing; setting new hw fault state to ${stateMap.hwFaultState}; sending event message  (${Event.HW_FAULT_CLEARING})`);
                            stateMap.delayTime = reading.ts + (parseInt(hwAlertRule.holdTime, 10) * 60000);  // holdTime is in minutes
                            messages.events.push(generateEvent(reading, Event.HW_FAULT_CLEARING, stateMap.id));                            
                            persistAlertStateMap(stateMap);
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_CLEARING:
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_CLEARING: {
                            if (reading.ts >= stateMap.delayTime) {
                                log('DEBUG', `[${reading.id}] HW fault hold time has expired; setting HW state to NORMAL; sending alert cleared message`);
                                stateMap.active = false;
                                stateMap.hwFaultState = HW_FAULT_ALERT_STATE.NORMAL;
                                stateMap.receivedReceipt = false;  // reset to keep track if cleared message received by 
                                messages.alerts.push(generateAlert(stateMap, NotificationType.CLEARED, (alertRule == null ? null : alertRule.pointGroup)));
                                persistAlertStateMap(stateMap);
                            } 
                            break;
                        }
                    }
                    break;
                }
                case ALERT_STATE.WARNING_DELAYING: 
                case ALERT_STATE.CRITICAL_DELAYING: {
                    // Return the point to the NORMAL state, this is done by deleting the point's alert state map.  This can
                    // just be deleted here because it never reached an active alerting state.
                    log('DEBUG', `[${reading.id}] Alert level has cleared; deleting state map [${stateMap.state}]; sending event message (${Event.DELAY_CANCELLED})`);
                    deleteAlertStateMap(stateMap);
                    messages.events.push(generateEvent(reading, Event.DELAY_CANCELLED, stateMap.id));
                    break;
                }
                case ALERT_STATE.WARNING_ACTIVE:
                case ALERT_STATE.CRITICAL_ACTIVE:
                case ALERT_STATE.CRITICAL_REACHED_DELAYING: {
                    const level = (stateMap.state === ALERT_STATE.CRITICAL_ACTIVE ? 'CRITICAL' : 'WARNING');
                    if (alertRule.clearSeconds === 0) {
                        log('DEBUG', `[${reading.id}] ${level} alert level has cleared; alert rule has no clear delay; setting new state to NORMAL; sending alert cleared message`);
                        stateMap.active = false;
                        stateMap.state = ALERT_STATE.NORMAL;
                        stateMap.receivedReceipt = false;  // reset to keep track if cleared message received by 
                        messages.alerts.push(generateAlert(stateMap, NotificationType.CLEARED, alertRule.pointGroup));                       
                        persistAlertStateMap(stateMap);
                    } else {
                        stateMap.state = (stateMap.state === ALERT_STATE.CRITICAL_ACTIVE ? ALERT_STATE.CRITICAL_CLEARING : ALERT_STATE.WARNING_CLEARING);
                        log('DEBUG', `[${reading.id}] ${level} alert level has cleared; alert rule has a clear delay; setting new state to ${stateMap.state}; sending event message  (${Event.CLEAR_DELAYING})`);
                        stateMap.delay = (parseInt(alertRule.clearSeconds, 10) * 1000);
                        stateMap.delayTime = reading.ts + stateMap.delay;
                        messages.events.push(generateEvent(reading, Event.CLEAR_DELAYING, stateMap.id));                       
                        persistAlertStateMap(stateMap);
                    }
                    break;
                }
                case ALERT_STATE.WARNING_CLEARING:
                case ALERT_STATE.CRITICAL_CLEARING: {
                    if (reading.ts >= stateMap.delayTime) {
                        log('DEBUG', `[${reading.id}] Clear delay has expired; sending alert cleared message`);
                        stateMap.active = false;
                        stateMap.state = ALERT_STATE.NORMAL;
                        stateMap.receivedReceipt = false;  // reset to keep track if cleared message received by 
                        messages.alerts.push(generateAlert(stateMap, NotificationType.CLEARED, (alertRule == null ? null : alertRule.pointGroup)));
                        persistAlertStateMap(stateMap);
                    } 
                    break;
                }
            }
            break;
        }
        case AlertLevel.SENSOR_FAULT: {
            // What happens next depends on the point current alert state
            switch (stateMap.state) {
                case ALERT_STATE.NORMAL: {
                    switch (stateMap.hwFaultState) {
                        case HW_FAULT_ALERT_STATE.NORMAL: {
                            log('DEBUG', `[${reading.id}] Sensor fault detected; setting new hw fault state to SENSOR_FAULT_DELAYING; sending event message (HW_FAULT_DELAYING)`);
                            stateMap.active = true;
                            stateMap.hwFaultState = HW_FAULT_ALERT_STATE.SENSOR_FAULT_DELAYING;
                            // stateMap.delayTime = reading.ts + (parseInt(hwAlertRule.holdTime, 10) * 60000);  // holdTime is in minutes
                            messages.events.push(generateEvent(reading, Event.HW_FAULT_DELAYING, stateMap.id));
                            persistAlertStateMap(stateMap);
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_DELAYING: {
                            if (reading.ts >= stateMap.delayTime) {
                                log('DEBUG', `[${reading.id}] HW fault hold time has expired; setting hw fault state to SENSOR_FAULT_ACTIVE; sending alert message`);
                                stateMap.active = true;
                                stateMap.hwFaultState = HW_FAULT_ALERT_STATE.SENSOR_FAULT_ACTIVE;
                                stateMap.receivedReceipt = false;  // reset to keep track if cleared message received by WatchdogEX
                                stateMap.started = Date.now();
                                messages.alerts.push(generateAlert(stateMap, NotificationType.HW_FAULT_ACTIVE, (alertRule == null ? null : alertRule.pointGroup)));
                                persistAlertStateMap(stateMap);
                            }
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_ACTIVE: {
                            // status quo maintained, nothing to do
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_CLEARING: {
                            log('DEBUG', `[${reading.id}] Back in sensor fault before hold time expired; setting state back to SENSOR_FAULT_ACTIVE; sending event message (${Event.CLEAR_CANCELLED})`);
                            stateMap.hwFaultState = HW_FAULT_ALERT_STATE.SENSOR_FAULT_ACTIVE;
                            stateMap.delayTime = 0;
                            messages.events.push(generateEvent(reading, Event.CLEAR_CANCELLED, stateMap.id));                      
                            persistAlertStateMap(stateMap);
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_DELAYING: {
                            log('DEBUG', `[${reading.id}] Sensor fault detected while in COMM_LOSS_DELAYING; setting hw fault state to SENSOR_FAULT_DELAYING; sending event messages (HW_FAULT_CLEARED and HW_FAULT_DELAYING)`);
                            // just delete the delaying state map, it was never an active alert so this is ok
                            deleteAlertStateMap(stateMap);
                            const event1 = generateEvent(reading, Event.HW_FAULT_CLEARED, stateMap.id);
                            messages.events.push(event1);
                            // Now need to create a new state map for sensor fault delaying.
                            stateMap = buildNewStateMap(stateMap.pointId, reading, alertCondition, hwAlertRule);
                            stateMap.hwFaultState = HW_FAULT_ALERT_STATE.SENSOR_FAULT_DELAYING;
                            const event2 = generateEvent(reading, Event.HW_FAULT_DELAYING, stateMap.id);
                            // make sure the event2 is after event1
                            event2.ts = parseInt(event1.ts, 10) + 1;
                            messages.events.push(event2);
                            persistAlertStateMap(stateMap);
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_ACTIVE:
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_CLEARING: {
                            log('DEBUG', `[${reading.id}] Sensor fault detected while COMM_LOSS_ACTIVE or COMM_LOSS_CLEARING; setting hw fault state to SENSOR_FAULT_DELAYING; sending alert cleared message; sending event message (HW_FAULT_DELAYING)`);
                            stateMap.active = false;
                            stateMap.hwFaultState = HW_FAULT_ALERT_STATE.NORMAL;
                            stateMap.receivedReceipt = false;  // reset to keep track if cleared message received by 
                            const alert = generateAlert(stateMap, NotificationType.CLEARED, (alertRule == null ? null : alertRule.pointGroup));
                            messages.alerts.push(alert);
                            persistAlertStateMap(stateMap);
                            // The persist above will delete the state map for the CL alert because active is set to false.  Now need to create a 
                            // new state map for sensor fault delaying.
                            stateMap = buildNewStateMap(stateMap.pointId, reading, alertCondition, hwAlertRule);
                            stateMap.hwFaultState = HW_FAULT_ALERT_STATE.SENSOR_FAULT_DELAYING;
                            const event = generateEvent(reading, Event.HW_FAULT_DELAYING, stateMap.id);
                            // make sure the event is after the alert
                            event.ts = parseInt(alert.ts, 10) + 1;
                            messages.events.push(event);
                            persistAlertStateMap(stateMap);
                            break;
                        }
                    }
                    break;
                }
                case ALERT_STATE.WARNING_DELAYING: 
                case ALERT_STATE.CRITICAL_DELAYING: {
                    log('DEBUG', `[${reading.id}] Sensor fault detected; setting state to NORMAL; setting hw fault state to SENSOR_FAULT_DELAYING; sending event messages (DELAY_CANCELLED, HW_FAULT_DELAYING)`);
                    // just delete the delaying state map, it was never an active alert so this is ok
                    deleteAlertStateMap(stateMap);
                    const event1 = generateEvent(reading, Event.DELAY_CANCELLED, stateMap.id);
                    messages.events.push(event1);
                    // Now need to create a new state map for sensor fault delaying.
                    stateMap = buildNewStateMap(stateMap.pointId, reading, alertCondition, hwAlertRule);
                    stateMap.hwFaultState = HW_FAULT_ALERT_STATE.SENSOR_FAULT_DELAYING;
                    const event2 = generateEvent(reading, Event.HW_FAULT_DELAYING, stateMap.id);
                    // make sure the event2 is after event1
                    event2.ts = parseInt(event1.ts, 10) + 1;
                    messages.events.push(event2);
                    persistAlertStateMap(stateMap);
                    break;
                }
                case ALERT_STATE.WARNING_ACTIVE:
                case ALERT_STATE.WARNING_CLEARING:
                case ALERT_STATE.CRITICAL_ACTIVE:
                case ALERT_STATE.CRITICAL_CLEARING: {
                    log('DEBUG', `[${reading.id}] Sensor fault detected during active WARNING/CRITICAL alert; sending alert closed message; creating new hw fault state map for SENSOR_FAULT_DELAYING; sending event message (HW_FAULT_DELAYING)`);
                    stateMap.active = false;
                    stateMap.hwFaultState = HW_FAULT_ALERT_STATE.NORMAL;
                    stateMap.receivedReceipt = false;  // reset to keep track if cleared message received by 
                    const alert = generateAlert(stateMap, NotificationType.CLOSED__HW_FAULT, (alertRule == null ? null : alertRule.pointGroup));
                    messages.alerts.push(alert);
                    persistAlertStateMap(stateMap);
                    // The persist above will delete the state map for the alert because active is set to false.  Now need to create a 
                    // new state map for sensor fault delaying.
                    stateMap = buildNewStateMap(stateMap.pointId, reading, alertCondition, hwAlertRule);
                    stateMap.hwFaultState = HW_FAULT_ALERT_STATE.SENSOR_FAULT_DELAYING;
                    const event = generateEvent(reading, Event.HW_FAULT_DELAYING, stateMap.id);
                    // make sure the event is after the alert
                    event.ts = parseInt(alert.ts, 10) + 1;
                    messages.events.push(event);
                    persistAlertStateMap(stateMap);
                    break;
                }
            }
            break;
        }
        case AlertLevel.COMM_LOSS: {
            // What happens next depends on the point current alert state
            switch (stateMap.state) {
                case ALERT_STATE.NORMAL: {
                    switch (stateMap.hwFaultState) {
                        case HW_FAULT_ALERT_STATE.NORMAL: {
                            log('DEBUG', `[${reading.id}] Comm loss detected; changing hw fault state from ${stateMap.hwFaultState} to COMM_LOSS_DELAYING; sending event message (HW_FAULT_DELAYING)`);
                            stateMap.active = true;
                            stateMap.hwFaultState = HW_FAULT_ALERT_STATE.COMM_LOSS_DELAYING;                            
                            stateMap.initialDetection = Date.now();
                            stateMap.triggeredValue = JSON.parse(JSON.stringify(reading));
                            messages.events.push(generateEvent(reading, Event.HW_FAULT_DELAYING, stateMap.id));
                            persistAlertStateMap(stateMap);
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_DELAYING: {
                            log('DEBUG', `[${reading.id}] Comm loss detected; changing hw fault state from ${stateMap.hwFaultState} to COMM_LOSS_DELAYING; sending event messages (DELAY_CANCELLED and HW_FAULT_DELAYING)`);
                            // just delete the delaying state map, it was never an active alert so this is ok
                            deleteAlertStateMap(stateMap);
                            const event1 = generateEvent(reading, Event.HW_FAULT_CLEARED, stateMap.id);
                            messages.events.push(event1);
                            // Now need to create a new state map for sensor fault delaying.
                            stateMap = buildNewStateMap(stateMap.pointId, reading, alertCondition, hwAlertRule);
                            stateMap.hwFaultState = HW_FAULT_ALERT_STATE.COMM_LOSS_DELAYING;
                            const event2 = generateEvent(reading, Event.HW_FAULT_DELAYING, stateMap.id);
                            // make sure the event2 is after event1
                            event2.ts = parseInt(event1.ts, 10) + 1;
                            messages.events.push(event2);
                            persistAlertStateMap(stateMap);
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_ACTIVE:
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_CLEARING: {
                            log('DEBUG', `[${reading.id}] Comm loss detected while SENSOR_FAULT_ACTIVE/CLEARING; setting hw fault state to COMM_LOSS_DELAYING; sending alert cleared message; sending event message (HW_FAULT_DELAYING)`);
                            // Need to close the active sensor fault alert
                            stateMap.active = false;
                            stateMap.hwFaultState = HW_FAULT_ALERT_STATE.NORMAL;
                            stateMap.receivedReceipt = false;  // reset to keep track if cleared message received by 
                            const alert = generateAlert(stateMap, NotificationType.CLEARED, (alertRule == null ? null : alertRule.pointGroup));
                            messages.alerts.push(alert);
                            persistAlertStateMap(stateMap);
                            // The persist above will delete the state map for the SF alert because active is set to false.  Now need to create a 
                            // new state map for comm loss delaying.
                            stateMap = buildNewStateMap(stateMap.pointId, reading, alertCondition, hwAlertRule);
                            stateMap.hwFaultState = HW_FAULT_ALERT_STATE.COMM_LOSS_DELAYING;
                            const event = generateEvent(reading, Event.HW_FAULT_DELAYING, stateMap.id);
                            // make sure the event is after the alert
                            event.ts = parseInt(alert.ts, 10) + 1;
                            messages.events.push(event);
                            persistAlertStateMap(stateMap);
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_DELAYING: {
                            if (reading.ts >= stateMap.delayTime) {
                                log('DEBUG', `[${reading.id}] HW fault hold time has expired; setting hw fault state to COMM_LOSS_ACTIVE; sending alert message`);
                                stateMap.active = true;
                                stateMap.hwFaultState = HW_FAULT_ALERT_STATE.COMM_LOSS_ACTIVE;
                                stateMap.receivedReceipt = false;  // reset to keep track if cleared message received by WatchdogEX
                                stateMap.started = Date.now();
                                messages.alerts.push(generateAlert(stateMap, NotificationType.HW_FAULT_ACTIVE, (alertRule == null ? null : alertRule.pointGroup)));
                                persistAlertStateMap(stateMap);
                            }
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_ACTIVE: {
                            // No change, nothing to do
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_CLEARING: {
                            log('DEBUG', `[${reading.id}] Back in comm loss before hold time expired; setting state back to COMM_LOSS_ACTIVE; sending event message (${Event.CLEAR_CANCELLED})`);
                            stateMap.hwFaultState = HW_FAULT_ALERT_STATE.COMM_LOSS_ACTIVE;
                            stateMap.delayTime = 0;
                            messages.events.push(generateEvent(reading, Event.CLEAR_CANCELLED, stateMap.id));
                            persistAlertStateMap(stateMap);
                            break;
                        }
                    }
                    break;
                }
                case ALERT_STATE.WARNING_DELAYING: 
                case ALERT_STATE.CRITICAL_DELAYING: {
                    log('DEBUG', `[${reading.id}] Comm loss detected; setting state to NORMAL; setting hw fault state to COMM_LOSS_DELAYING; sending event messages (DELAY_CANCELLED, HW_FAULT_DELAYING)`);
                    // just delete the delaying state map, it was never an active alert so this is ok
                    deleteAlertStateMap(stateMap);
                    const event1 = generateEvent(reading, Event.DELAY_CANCELLED, stateMap.id);
                    messages.events.push(event1);
                    // Now need to create a new state map for comm loss delaying.
                    stateMap = buildNewStateMap(stateMap.pointId, reading, alertCondition, hwAlertRule);
                    stateMap.hwFaultState = HW_FAULT_ALERT_STATE.COMM_LOSS_DELAYING;
                    const event2 = generateEvent(reading, Event.HW_FAULT_DELAYING, stateMap.id);
                    // make sure event2 is after event1
                    event2.ts = parseInt(event1.ts, 10) + 1;
                    messages.events.push(event2);
                    persistAlertStateMap(stateMap);
                    break;
                }
                case ALERT_STATE.WARNING_ACTIVE:
                case ALERT_STATE.WARNING_CLEARING:
                case ALERT_STATE.CRITICAL_ACTIVE:
                case ALERT_STATE.CRITICAL_CLEARING: {
                    log('DEBUG', `[${reading.id}] Comm loss detected during active WARNING/CRITICAL alert; sending alert closed message; creating new hw fault state map for COMM_LOSS_DELAYING; sending event message (HW_FAULT_DELAYING)`);
                    stateMap.active = false;
                    stateMap.hwFaultState = HW_FAULT_ALERT_STATE.NORMAL;
                    stateMap.receivedReceipt = false;  // reset to keep track if cleared message received by 
                    const alert = generateAlert(stateMap, NotificationType.CLOSED__HW_FAULT, (alertRule == null ? null : alertRule.pointGroup));
                    messages.alerts.push(alert);
                    persistAlertStateMap(stateMap);
                    // The persist above will delete the state map for the alert because active is set to false.  Now need to create a 
                    // new state map for sensor fault delaying.
                    stateMap = buildNewStateMap(stateMap.pointId, reading, alertCondition, hwAlertRule);
                    stateMap.hwFaultState = HW_FAULT_ALERT_STATE.COMM_LOSS_DELAYING;
                    const event = generateEvent(reading, Event.HW_FAULT_DELAYING, stateMap.id);
                    // make sure the event is after the alert
                    event.ts = parseInt(alert.ts, 10) + 1;
                    messages.events.push(event);
                    persistAlertStateMap(stateMap);
                    break;
                }
            }
            break;
        }
        case AlertLevel.WARNING: {
            // What happens next depends on the point current alert state
            switch (stateMap.state) {
                case ALERT_STATE.NORMAL: {
                    switch (stateMap.hwFaultState) {
                        case HW_FAULT_ALERT_STATE.NORMAL: {
                            stateMap.active = true; 
                            stateMap.initialDetection = Date.now();
                            stateMap.triggeredValue = JSON.parse(JSON.stringify(reading));
                            if (alertRule.delaySeconds !== 0) {
                                log('DEBUG', `[${reading.id}] alert rule has a delay; setting new state to WARNING_DELAYING; sending event message (ALERT_DELAYING)`);
                                stateMap.state = ALERT_STATE.WARNING_DELAYING;
                                messages.events.push(generateEvent(reading, Event.WARNING_ALERT_DELAYING, stateMap.id));
                            } else {
                                log('DEBUG', `[${reading.id}] alert rule has no delay; setting new state to WARNING_ACTIVE; sending alert message`);
                                stateMap.state = ALERT_STATE.WARNING_ACTIVE;
                                stateMap.started = stateMap.initialDetection;
                                messages.alerts.push(generateAlert(stateMap, NotificationType.ACTIVE, (alertRule == null ? null : alertRule.pointGroup)));
                            }
                            persistAlertStateMap(stateMap);
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_DELAYING:
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_DELAYING: {
                            // Delete the HW fault delaying state, this can be done because it was still delaying and
                            // not an active alert.
                            deleteAlertStateMap(stateMap);
                            const event1 = generateEvent(reading, Event.DELAY_CANCELLED, stateMap.id);
                            messages.events.push(event1);
                            // Create the new state map
                            stateMap = buildNewStateMap(stateMap.pointId, reading, alertCondition, alertRule);
                            if (alertRule.delaySeconds !== 0) {
                                log('DEBUG', `[${reading.id}] alert rule has a delay; setting new state to WARNING_DELAYING; sending event message (ALERT_DELAYING)`);
                                stateMap.state = ALERT_STATE.WARNING_DELAYING;
                                const event2 = generateEvent(reading, Event.WARNING_ALERT_DELAYING, stateMap.id);
                                // make sure event2 after event1
                                event2.ts = parseInt(event1.ts, 10) + 1;
                                messages.events.push(event2);
                            } else {
                                log('DEBUG', `[${reading.id}] alert rule has no delay; setting new state to WARNING_ACTIVE; sending alert message`);
                                stateMap.state = ALERT_STATE.WARNING_ACTIVE;
                                stateMap.started = Date.now();
                                const alert = generateAlert(stateMap, NotificationType.ACTIVE, (alertRule == null ? null : alertRule.pointGroup));
                                // make sure alert is after event
                                alert.ts = parseInt(event1.ts, 10) + 1;
                                messages.alerts.push(alert);
                            }
                            persistAlertStateMap(stateMap);
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_ACTIVE:
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_CLEARING:
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_ACTIVE:
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_CLEARING: {                            
                            // TODO CAN THIS BE DONE??? Should it actually go into clearing??
                            // Delete the HW fault delaying state, this can be done because it was still delaying and
                            // not an active alert.
                            deleteAlertStateMap(stateMap);
                            const alert = generateAlert(stateMap, NotificationType.CLEARED, (alertRule == null ? null : alertRule.pointGroup));
                            messages.alerts.push(alert);
                            // Create the new state map for the WARNING 
                            stateMap = buildNewStateMap(stateMap.pointId, reading, alertCondition, alertRule);
                            if (alertRule.delaySeconds !== 0) {
                                log('DEBUG', `[${reading.id}] alert rule has a delay; setting new state to WARNING_DELAYING; sending event message (ALERT_DELAYING)`);
                                stateMap.state = ALERT_STATE.WARNING_DELAYING;
                                const event = generateEvent(reading, Event.WARNING_ALERT_DELAYING, stateMap.id);
                                // make sure the event is after the alert
                                event.ts = parseInt(alert.ts, 10) + 1;
                                messages.events.push(event);
                            } else {
                                log('DEBUG', `[${reading.id}] alert rule has no delay; setting new state to WARNING_ACTIVE; sending alert message`);
                                stateMap.state = ALERT_STATE.WARNING_ACTIVE;
                                stateMap.started = Date.now();
                                const alert2 = generateAlert(stateMap, NotificationType.ACTIVE, (alertRule == null ? null : alertRule.pointGroup));
                                // make sure this alert is after the first alert
                                alert2.ts = parseInt(alert.ts, 10) + 1;
                                messages.alerts.push(alert2);
                            }
                            persistAlertStateMap(stateMap);
                            break;
                        }
                    }
                    break;
                }
                case ALERT_STATE.WARNING_DELAYING: {
                    // Ignoring stateMap.hwFaultState because this should only be NORMAL for this state
                    if (reading.ts >= stateMap.delayTime) {
                        log('DEBUG', `[${reading.id}] delay has expired; setting new state to WARNING_ACTIVE; sending alert active message`);
                        stateMap.state = ALERT_STATE.WARNING_ACTIVE;
                        stateMap.started = Date.now();
                        messages.alerts.push(generateAlert(stateMap, NotificationType.ACTIVE, (alertRule == null ? null : alertRule.pointGroup)));
                        persistAlertStateMap(stateMap);
                    } 
                    break;
                }
                case ALERT_STATE.WARNING_ACTIVE: {
                    log('DEBUG', `[${reading.id}] state unchanged, nothing to do`);
                    break;
                }
                case ALERT_STATE.WARNING_CLEARING: {
                    log('DEBUG', `[${reading.id}] back in alert before clear delay expired; setting state back to ${stateMap.state}; sending event message (${Event.CLEAR_CANCELLED})`);
                    stateMap.state = ALERT_STATE.WARNING_ACTIVE;
                    stateMap.delay = parseInt(alertRule.delaySeconds, 10) * 1000;
                    stateMap.delayTime = 0;
                    messages.events.push(generateEvent(reading, Event.CLEAR_CANCELLED, stateMap.id));
                    persistAlertStateMap(stateMap);
                    break;
                }
                case ALERT_STATE.CRITICAL_REACHED_DELAYING: {
                    // Just need to create an event to indicate the critical condition has
                    // cleared and return state to WARNING_ACTIVE.
                    log('DEBUG', `[${reading.id}] alert level returned to warning; setting state back to ${ALERT_STATE.WARNING_ACTIVE}; sending event message (${Event.CLEAR_DELAYING})`);
                    stateMap.state = ALERT_STATE.WARNING_ACTIVE;
                    stateMap.delay = (parseInt(alertRule.delaySeconds, 10) * 1000);
                    stateMap.delayTime = stateMap.triggeredValue.ts + stateMap.delay;
                    messages.events.push(generateEvent(reading, Event.CLEAR_DELAYING, stateMap.id));                       
                    persistAlertStateMap(stateMap);
                    break;
                }
                case ALERT_STATE.CRITICAL_DELAYING: {
                    // Ignoring stateMap.hwFaultState because this should only be NORMAL for this state
                    if (alertRule.delaySeconds === 0) {
                        log('DEBUG', `[${reading.id}] warning detected; warning delay is 0; setting new state to WARNING_ACTIVE; sending WARNING alert active message`);
                        stateMap.state = ALERT_STATE.WARNING_ACTIVE;
                        stateMap.started = Date.now();
                        // Need to change the level so that the correct alert type gets created
                        stateMap.triggeringCondition.level = AlertLevel.WARNING;
                        stateMap.delay = 0;
                        stateMap.delayTime = stateMap.triggeredValue.ts;
                        messages.alerts.push(generateAlert(stateMap, NotificationType.ACTIVE, (alertRule == null ? null : alertRule.pointGroup)));
                        persistAlertStateMap(stateMap);
                    } else {
                        // Check if critical delay has expired                        
                        if (reading.ts >= stateMap.delayTime) {
                            log('DEBUG', `[${reading.id}] warning detected; warning delay is > 0; critical delay is expired; sending CRITICAL alert active message`);
                            stateMap.state = ALERT_STATE.CRITICAL_ACTIVE;
                            stateMap.started = Date.now();
                            messages.alerts.push(generateAlert(stateMap, NotificationType.ACTIVE, (alertRule == null ? null : alertRule.pointGroup)));
                            persistAlertStateMap(stateMap);
                        } else {
                            log('DEBUG', `[${reading.id}] warning detected; CRITICAL_DELAYING still active; nothing to do`);
                        }
                    }
                    break;
                }
                case ALERT_STATE.CRITICAL_ACTIVE: {
                    log('DEBUG', `[${reading.id}] WARNING level detected; already in CRITICAL state; nothing to do`);
                    break;
                }
                case ALERT_STATE.CRITICAL_CLEARING: {
                    log('DEBUG', `[${reading.id}] back in alert before clear delay expired; setting state back to CRITICAL_ACTIVE; sending event message (CLEAR_CANCELLED)`);
                    stateMap.state = ALERT_STATE.CRITICAL_ACTIVE;
                    stateMap.delay = parseInt(alertRule.criticalDelaySeconds ? alertRule.criticalDelaySeconds : 0, 10) * 1000;
                    stateMap.delayTime = 0;
                    messages.events.push(generateEvent(reading, Event.CLEAR_CANCELLED, stateMap.id));
                    persistAlertStateMap(stateMap);
                    break;
                }
            }
            break;
        }
        case AlertLevel.CRITICAL: {
            // What happens next depends on the point current alert state
            switch (stateMap.state) {
                case ALERT_STATE.NORMAL: {
                    switch (stateMap.hwFaultState) {
                        case HW_FAULT_ALERT_STATE.NORMAL: {
                            log('DEBUG', `[${reading.id}] alert level has escalated to CRITICAL; setting state to CRITICAL_ACTIVE; sending alert active message`);
                            stateMap.active = true; 
                            stateMap.initialDetection = Date.now();
                            stateMap.triggeredValue = JSON.parse(JSON.stringify(reading));
                            if (alertRule.hasOwnProperty('criticalDelaySeconds') && alertRule.criticalDelaySeconds !== 0) {
                                log('DEBUG', `[${reading.id}] alert rule has a critical delay; setting new state to CRITICAL_DELAYING; sending event message (ALERT_DELAYING)`);
                                stateMap.state = ALERT_STATE.CRITICAL_DELAYING;
                                messages.events.push(generateEvent(reading, Event.CRITICAL_ALERT_DELAYING, stateMap.id));
                            } else {
                                log('DEBUG', `[${reading.id}] alert rule has no critical delay; setting new state to CRITICAL_ACTIVE; sending alert message`);
                                stateMap.state = ALERT_STATE.CRITICAL_ACTIVE;
                                stateMap.started = stateMap.initialDetection;
                                messages.alerts.push(generateAlert(stateMap, NotificationType.ACTIVE, (alertRule == null ? null : alertRule.pointGroup)));
                            }
                            persistAlertStateMap(stateMap);
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_DELAYING:
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_DELAYING: {
                            // Delete the HW fault delaying state, this can be done because it was still delaying and
                            // not an active alert.
                            log('DEBUG', `[${reading.id}] alert level has escalated to CRITICAL; cancelling DELAYING state; sending delay cancelled event message`);
                            deleteAlertStateMap(stateMap);
                            const event = generateEvent(reading, Event.DELAY_CANCELLED, stateMap.id);
                            messages.events.push(event);
                            // Create the new state map
                            stateMap = buildNewStateMap(stateMap.pointId, reading, alertCondition, alertRule);
                            if (alertRule.hasOwnProperty('criticalDelaySeconds') && alertRule.criticalDelaySeconds !== 0) {
                                log('DEBUG', `[${reading.id}] alert rule has a critical delay; setting new state to CRITICAL_DELAYING; sending event message (ALERT_DELAYING)`);
                                stateMap.state = ALERT_STATE.CRITICAL_DELAYING;
                                stateMap.delay = parseInt(alertRule.criticalDelaySeconds, 10) * 1000;
                                stateMap.delayTime = stateMap.triggeredValue.ts + stateMap.delay;
                                const event2 = generateEvent(reading, Event.CRITICAL_ALERT_DELAYING, stateMap.id);
                                // make sure event2 after event1
                                event2.ts = parseInt(event.ts, 10) + 1;
                                messages.events.push(event2);
                            } else {
                                log('DEBUG', `[${reading.id}] alert rule has no critical delay; setting new state to CRITICAL_ACTIVE; sending alert message`);
                                stateMap.state = ALERT_STATE.CRITICAL_ACTIVE;
                                stateMap.started = Date.now();
                                const alert = generateAlert(stateMap, NotificationType.ACTIVE, (alertRule == null ? null : alertRule.pointGroup));
                                // make sure alert after the event
                                alert.ts = parseInt(event.ts, 10) + 1;
                                messages.alerts.push(alert);
                            }
                            persistAlertStateMap(stateMap);
                            break;
                        }
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_ACTIVE:
                        case HW_FAULT_ALERT_STATE.SENSOR_FAULT_CLEARING:
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_ACTIVE:
                        case HW_FAULT_ALERT_STATE.COMM_LOSS_CLEARING: {                         
                            // TODO CAN THIS BE DONE??? Should it actually go into clearing??
                            // Delete the HW fault delaying state, this can be done because it was still delaying and
                            // not an active alert.
                            log('DEBUG', `[${reading.id}] alert level has escalated to CRITICAL; cancelling the ${stateMap.hwFaultState} alert; sending cancelled alert message`);
                            deleteAlertStateMap(stateMap);
                            const alert = generateAlert(stateMap, NotificationType.CLEARED, (alertRule == null ? null : alertRule.pointGroup));
                            messages.alerts.push(alert);
                            // Create the new state map for the CRITICAL 
                            stateMap = buildNewStateMap(stateMap.pointId, reading, alertCondition, alertRule);
                            if (alertRule.hasOwnProperty('criticalDelaySeconds') && alertRule.criticalDelaySeconds !== 0) {
                                log('DEBUG', `[${reading.id}] alert rule has a critical delay; setting new state to CRITICAL_DELAYING; sending event message (ALERT_DELAYING)`);
                                stateMap.state = ALERT_STATE.CRITICAL_DELAYING;
                                const event = generateEvent(reading, Event.CRITICAL_ALERT_DELAYING, stateMap.id);
                                // make sure the event is after the alert
                                event.ts = parseInt(alert.ts, 10) + 1;
                                messages.events.push(event);
                            } else {
                                log('DEBUG', `[${reading.id}] alert rule has no critical delay; setting new state to CRITICAL_ACTIVE; sending alert message`);
                                stateMap.state = ALERT_STATE.CRITICAL_ACTIVE;
                                stateMap.started = Date.now();
                                const alert2 = generateAlert(stateMap, NotificationType.ACTIVE, (alertRule == null ? null : alertRule.pointGroup));
                                // make sure alert2 is after alert
                                alert2.ts = parseInt(alert.ts, 10) + 1;
                                messages.alerts.push(alert2);
                            }
                            persistAlertStateMap(stateMap);
                            break;
                        }
                    }
                    break;
                }
                case ALERT_STATE.WARNING_DELAYING: {
                    const criticalDelaySeconds = alertRule.hasOwnProperty('criticalDelaySeconds') ? alertRule.criticalDelaySeconds : 0;
                    if (criticalDelaySeconds === 0) {
                        log('DEBUG', `[${reading.id}] alert level has escalated to CRITICAL; no critical delay; setting state to CRITICAL_ACTIVE; sending alert active message`);
                        stateMap.triggeringCondition = JSON.parse(JSON.stringify(alertCondition));
                        stateMap.state = ALERT_STATE.CRITICAL_ACTIVE;
                        stateMap.started = Date.now();
                        stateMap.delay = 0;
                        stateMap.delayTime = stateMap.triggeredValue.ts;
                        messages.alerts.push(generateAlert(stateMap, NotificationType.ACTIVE, (alertRule == null ? null : alertRule.pointGroup)));
                        persistAlertStateMap(stateMap);
                    } else {                        
                        if (reading.ts >= stateMap.delayTime) {
                            log('DEBUG', `[${reading.id}] alert level has escalated to CRITICAL; critical delay; warning delay has expired; setting new state to CRITICAL_ACTIVE; sending alert active message`);
                            stateMap.triggeringCondition = JSON.parse(JSON.stringify(alertCondition));
                            stateMap.state = ALERT_STATE.CRITICAL_ACTIVE;
                            stateMap.started = Date.now();
                            messages.alerts.push(generateAlert(stateMap, NotificationType.ACTIVE, (alertRule == null ? null : alertRule.pointGroup)));
                            persistAlertStateMap(stateMap);
                        } else {
                            log('DEBUG', `[${reading.id}] alert level has escalated to CRITICAL; critical delay; warning delay has not expired`);
                        }
                    }
                    break;
                }
                case ALERT_STATE.WARNING_ACTIVE:
                case ALERT_STATE.WARNING_CLEARING: {
                    if (alertRule.hasOwnProperty('criticalDelaySeconds') && alertRule.criticalDelaySeconds !== 0) {
                        log('DEBUG', `[${reading.id}] alert rule has a critical delay; setting new state to CRITICAL_REACHED_DELAYING; sending event message (ALERT_DELAYING)`);
                        stateMap.state = ALERT_STATE.CRITICAL_REACHED_DELAYING;
                        stateMap.delay = (parseInt(alertRule.criticalDelaySeconds, 10) * 1000);
                        stateMap.delayTime = reading.ts + stateMap.delay;        
                        messages.events.push(generateEvent(reading, Event.CRITICAL_ALERT_DELAYING, stateMap.id));
                    } else {
                        log('DEBUG', `[${reading.id}] alert state has escalated to CRITICAL; setting state to CRITICAL_ACTIVE; sending reached critical alert message`);
                        stateMap.state = ALERT_STATE.CRITICAL_ACTIVE;
                        // reset the delay
                        stateMap.delay = (parseInt(alertRule.delaySeconds, 10) * 1000);
                        stateMap.delayTime = stateMap.triggeredValue.ts + stateMap.delay;                
                        stateMap.triggeringCondition.level = AlertLevel.CRITICAL;
                        messages.alerts.push(generateAlert(stateMap, NotificationType.REACHED_CRITICAL, (alertRule == null ? null : alertRule.pointGroup)));
                    }
                    persistAlertStateMap(stateMap);
                    break;
                }
                case ALERT_STATE.CRITICAL_REACHED_DELAYING: {
                    // Ignoring stateMap.hwFaultState because this should only be NORMAL for this state
                    if (reading.ts >= stateMap.delayTime) {
                        log('DEBUG', `[${reading.id}] critical delay has expired; alert state has escalated to CRITICAL; setting state to CRITICAL_ACTIVE; sending reached critical alert message`);
                        stateMap.state = ALERT_STATE.CRITICAL_ACTIVE;
                        // reset the delay
                        stateMap.delay = (parseInt(alertRule.delaySeconds, 10) * 1000);
                        stateMap.delayTime = stateMap.triggeredValue.ts + stateMap.delay;                
                        stateMap.triggeringCondition.level = AlertLevel.CRITICAL;
                        messages.alerts.push(generateAlert(stateMap, NotificationType.REACHED_CRITICAL, (alertRule == null ? null : alertRule.pointGroup)));
                        persistAlertStateMap(stateMap);
                    } else {
                        log('DEBUG', `[${reading.id}] critical delay has NOT expired; nothing to do`);
                    }
                    break;
                }
                case ALERT_STATE.CRITICAL_DELAYING: {
                    // Ignoring stateMap.hwFaultState because this should only be NORMAL for this state
                    if (reading.ts >= stateMap.delayTime) {
                        log('DEBUG', `[${reading.id}] critical delay has expired; setting new state to CRITICAL_ACTIVE; sending alert active message`);
                        stateMap.state = ALERT_STATE.CRITICAL_ACTIVE;
                        stateMap.started = Date.now();
                        messages.alerts.push(generateAlert(stateMap, NotificationType.ACTIVE, (alertRule == null ? null : alertRule.pointGroup)));
                        persistAlertStateMap(stateMap);
                    } 
                    break;
                }
                case ALERT_STATE.CRITICAL_ACTIVE: {
                    log('DEBUG', `[${reading.id}] alert state unchanged, still CRITICAL; nothing to do`);
                    break;
                }
                case ALERT_STATE.CRITICAL_CLEARING: {
                    log('DEBUG', `[${reading.id}] alert level returned to CRITICAL before clear delay expired; setting state back to CRITICAL_ACTIVE; sending event message (CLEAR_CANCELLED)`);
                    stateMap.state = ALERT_STATE.CRITICAL_ACTIVE;
                    stateMap.delay = parseInt(alertRule.criticalDelaySeconds ? alertRule.criticalDelaySeconds : 0, 10) * 1000;
                    stateMap.delayTime = 0;
                    messages.events.push(generateEvent(reading, Event.CLEAR_CANCELLED, stateMap.id));
                    persistAlertStateMap(stateMap);
                    break;
                }
            }
            break;
        }
    }
};

/**
 * Evaluate a point reading against a point alert rule to determine the readings current alert 
 * level and condition. *
 * @param reading
 * @param alertRule
 * @return Object representing a concern level: NONE, WARNING or CRITICAL.  Example, { level: 'WARNING', condition: 'HIGH' }
 */
const evaluateAlertCondition = (reading, alertRule) => {  
    // Check for any hardware faults, these override any threshold/state alerts
    if (reading.commLoss) return { level: AlertLevel.COMM_LOSS };
    if (reading.sensorFault) return { level: AlertLevel.SENSOR_FAULT };
    if (alertRule == null) return { level: AlertLevel.NONE };
    // No HW faults, check for threshold/state alerts
    switch (alertRule.pointGroup) {
        case PointGroup.ANALOG:
            return evaluateAnalogAlertCondition(reading, alertRule);
        case PointGroup.DIGITAL:
            return evaluateDigitalAlertCondition(reading, alertRule);
        case PointGroup.LIGHTING: 
		    return evaluateLightAlertCondition(reading, alertRule);
        default:
            return { level: AlertLevel.NONE };
    }
};

/**
 * Evaluate a analog point reading against a analog point alert rule to determine the readings current 
 * alert level and condition.
 * 
 * A value equal to or above the high critical threshold, if present, or equal to or below the low critical
 * threshold, if present, raises a critical level of concern. That is, it represents a condition that
 * urgently requires attention.
 *
 * A value equal to or above the normal high threshold, or equal to or below the normal low threshold, if
 * present, raises a warning level of concern, so long as the value does not raise a critical concern. That
 * is, it represents a condition that requires attention.
 *
 * Any other value is of no concern. That is, it represents an acceptable condition.
 * @param {*} reading 
 * @param {*} alertRule 
 * @returns 
 */
const evaluateAnalogAlertCondition = (reading, alertRule) => {
	const value = parseFloat(reading.value);

	// Check if high/low critical
	const isHighCritical = alertRule.highCriticalThreshold == null ? false : value >= parseFloat(alertRule.highCriticalThreshold);
	const isLowCritical = alertRule.lowCriticalThreshold == null ? false : value <= parseFloat(alertRule.lowCriticalThreshold);
	if (isHighCritical || isLowCritical) {
		return {
			level: AlertLevel.CRITICAL,
			condition: (isHighCritical ? AlertCondition.HIGH : AlertCondition.LOW)
		};
	}

	// Check if high/low warning
	const isHighWarning = alertRule.normalHighThreshold == null ? false : value >= parseFloat(alertRule.normalHighThreshold);
	const isLowWarning = alertRule.normalLowThreshold == null ? false : value <= parseFloat(alertRule.normalLowThreshold);
	if (isHighWarning || isLowWarning) {
		return {
			level: AlertLevel.WARNING,
			condition: (isHighWarning ? AlertCondition.HIGH : AlertCondition.LOW)
		};
	}

	// If this gets here then the condition is normal
	return { level: AlertLevel.NONE };
};

/**
 * Evaluate a digital point reading against a digital point alert rule to determine the readings current 
 * alert level and condition.
 * @param {*} reading 
 * @param {*} alertRule 
 * @returns 
 */
 const evaluateDigitalAlertCondition = (reading, alertRule) => {
	// check if critical state
	if (alertRule.criticalStates && alertRule.criticalStates.includes(reading.stateName)) {
		return { level: AlertLevel.CRITICAL, condition: AlertCondition.STATE };
	}
	// check if warning state
	if (alertRule.warningStates && alertRule.warningStates.includes(reading.stateName)) {
		return { level: AlertLevel.WARNING, condition: AlertCondition.STATE };
	}
	return { level: AlertLevel.NONE };
};

/**
 * Evaluate a light point reading against a light point alert rule to determine the readings current 
 * alert level and condition.
 * @param {*} reading 
 * @param {*} alertRule 
 * @returns 
 */
const evaluateLightAlertCondition = (reading, alertRule) => {
    log('DEBUG', `[${reading.id}] Evaluating light reading for alert condition`);
	for (let i = 0; i < alertRule.triggers.length; i++) {
		const trigger = alertRule.triggers[i];
		if (parseInt(LIGHT_STATE_MAP[trigger.expected_state], 10) === parseInt(reading.state, 10)) {
            if (isTriggerForTime(reading.ts, trigger)) {
                log('DEBUG', `[${reading.id}] Found a matching trigger: ${JSON.stringify(trigger)}`);
				return { level: trigger.alert_level, condition: AlertCondition.STATE };
			}
		}
	}
    log('DEBUG', `[${reading.id}] No matching triggers found.`);
	return { level: AlertLevel.NONE };
};

/**
 * Determine if the following schedule-based alert rule trigger is valid for the provided time.
 * @param {*} time Time in millis.
 * @param {*} trigger 
 * @returns 
 */
const isTriggerForTime = (ts, trigger) => {
    const timestamp = new Date(ts);
	const dow = timestamp.getDay();
    log('DEBUG', `Reading's DOW==${dow}`);
    if (trigger.daysOfWeek.indexOf(dow) !== -1) {
        const minutesSinceMidnight = (timestamp.getHours() * 60) + timestamp.getMinutes();
        log('DEBUG', `Reading's MOD==${minutesSinceMidnight}`);
        const endMinute = (trigger.endMinute === 0 ? 1440 : trigger.endMinute);
		if (minutesSinceMidnight >= trigger.startMinute && minutesSinceMidnight < endMinute) {
			return true;
		}
	}
	return false;
};

/**
 * Generate an event message to be published to WatchdogEX.
 * @param {*} reading The point reading for which the event is being created.
 * @param {*} event The event to create.
 * @param {*} stateMap The ID of the alert rule for which this event should be attached.
 * @param {number} alertId The ID of the alert.
 * @returns 
 */
const generateEvent = (reading, event, alertId) => {
    const message = {
        customer: reading.customer,
        id: reading.id,
        ts: Date.now(),
        type: 'event',
        event: event,
        entity: 'POINT'
    };
    if (alertId != null) message.alertId = alertId;
    return message;
};

/**
 * Generate an alert message to be published to WatchdogEX.
 * @param {*} alertStateMap 
 * @param {*} notificationType 
 * @param {*} pointGroup 
 * @param {*} additionalAttributes 
 * @returns 
 */
const generateAlert = (alertStateMap, notificationType, pointGroup, additionalAttributes) => {
    // Create default alert message 
    const alert = {
        alertId: alertStateMap.id,
        ruleId: alertStateMap.alertSetupId,
        becameActiveTimestamp: alertStateMap.started,
        created: alertStateMap.started,
        customerId: alertStateMap.triggeredValue.customer,
        notificationType: notificationType,
        pointId: alertStateMap.pointId,
        ts: Date.now()  
    };

    if (alertStateMap.lastPointValue.commLoss || alertStateMap.triggeredValue.commLoss) {
        alert.triggeredValue = 'COMM_LOSS';
        alert.concernLevel = AlertLevel.CRITICAL;
        alert.cause = 'COMM_LOSS';
    } else if (alertStateMap.lastPointValue.sensorFault || alertStateMap.triggeredValue.sensorFault) {
        alert.triggeredValue = 'SENSOR_FAULT';
        alert.concernLevel = AlertLevel.CRITICAL;
        alert.cause = 'SENSOR_FAULT';
    } else {
        alert.pointValue = alertStateMap.lastPointValue.value;
        alert.concernCondition = alertStateMap.triggeringCondition.condition;
        alert.concernLevel = alertStateMap.triggeringCondition.level;
        // pointGroup will be null for hardware fault alerts
        if (pointGroup) {
            switch (pointGroup) {
                case PointGroup.ANALOG:
                    // alert.pointValue = alertStateMap.lastPointValue.value;
                    alert.thresholdValue = alertStateMap.triggeringCondition.thresholdValue;
                    alert.triggeredStateIndex = '-1';
                    alert.triggeredValue = alertStateMap.triggeredValue.value;
                    break;
                case PointGroup.DIGITAL:
                case PointGroup.LIGHTING:
                    // alert.pointValue = alertStateMap.lastPointValue.state;
                    alert.thresholdValue = null;
                    alert.triggeredStateIndex = alertStateMap.triggeredValue.state;
                    alert.triggeredValue = alertStateMap.triggeredValue.stateName;
                    break;
            }
        }
    }

    switch (notificationType) {
        case NotificationType.CLEARED: {
            alert.clearedTimestamp = alertStateMap.lastPointValue.ts;
            break;
        }
        case NotificationType.CLOSED__THRESHOLD_ALERT: {
            alert.closedMessage = 'alert.closed.due.to.rule.update';
            break;
        }
        case NotificationType.CLOSED__RULE_DELETED: {
            alert.closedMessage = 'alert.closed.due.to.rule.deletion';
            alert.notificationType = NotificationType.CLOSED__THRESHOLD_ALERT;
            break;
        }
        case NotificationType.CLOSED__HW_FAULT: {
            alert.closedMessage = 'alert.closed.due.to.hardware.fault';
            break;
        }
        case NotificationType.CLOSED__CLEAN_MODE_ACTIVATED: {
            alert.closedMessage = 'alert.closed.due.to.clean.mode.activation';
            break;    
        }
        case NotificationType.CLOSED__ALERT_ENGINE_RESTARTED: {
            alert.closedMessage = 'alert.closed.due.to.controller.restarted';
            break;
        }
        default: {
            // Nothing to do
            break;
        }
    }

    if (additionalAttributes) {
        Object.keys(additionalAttributes).forEach(key => alert[key] = additionalAttributes[key]);
    }

    return alert;
};

const buildNewStateMap = (pointId, reading, alertCondition, alertRule) => {
    const stateMap = {
        active: true,
        id: Date.now(),
        pointId: pointId,
        state: ALERT_STATE.NORMAL,
        hwFaultState: HW_FAULT_ALERT_STATE.NORMAL,
        receivedReceipt: false,
        initialDetection: Date.now(),
        lastPointValue: JSON.parse(JSON.stringify(reading)),                            
        triggeredValue: JSON.parse(JSON.stringify(reading)),        
        triggeringCondition: JSON.parse(JSON.stringify(alertCondition)),
        alertSetupId: 0,
        delay: 0,
        delayTime: 0
    };
    if (alertRule != null) {
        stateMap.alertSetupId = alertRule.id;
        // The delay attribute depends on if this is for lighting (holdTime), otherwise based on
        // if critical or warning. 
        if (alertRule.hasOwnProperty('holdTime')) {
            stateMap.delay = parseInt(alertRule.holdTime, 10) * 60000;
        } else { 
            let delayKey;
            switch (alertCondition.level) {
                case AlertLevel.CRITICAL:
                    delayKey = 'criticalDelaySeconds';
                    break;
                case AlertLevel.WARNING_CLEARING:
                case AlertLevel.CRITICAL_CLEARING:
                    delayKey = 'clearSeconds';
                    break;
                default:
                    delayKey = 'delaySeconds';
            }
            if (alertRule.hasOwnProperty(delayKey)) 
                stateMap.delay = parseInt(alertRule[delayKey], 10) * 1000;
        }
        stateMap.delayTime = parseInt(reading.ts, 10) + parseInt(stateMap.delay, 10);
    }
    return stateMap;
};

/**
 * Write the alert state map to the file system.
 * @param {*} stateMap The state map to save.
 */
const persistAlertStateMap = (stateMap) => {    
    let filepath = null;
    if (stateMap.active) {
        filepath = `${ALERT_STATE_MAPS_DIRECTORY}/${stateMap.pointId}.json`;
    } else {
        // The state map is no longer active (cleared or closed), so remove it.
        deleteAlertStateMap(stateMap);
        // If the state map has not received the "received receipt", put it in the inactive directory.  Use the alert
        // ID for the file name in case multiple inactive state maps need to be recorded for the same point.
        if (stateMap.receivedReceipt == false) {
            log('DEBUG', `state map is no longer active and no receive receipt, moving to inactive directory`);
            filepath = `${ALERT_STATE_MAPS_INACTIVE_DIRECTORY}/${stateMap.id}.json`;
        }
    }

    if (filepath == null) return;    
    // log('DEBUG', `persisting state map to ${filepath}: ${JSON.stringify(stateMap, null, 4)}`);    
    log('DEBUG', `[${stateMap.pointId}] persisting state map to ${filepath}: ${JSON.stringify(stateMap, null, 4)}`);    
    fs.writeFileSync(filepath, JSON.stringify(stateMap, null, 4));
};

const deleteAlertStateMap = (stateMap) => {    
    // Active state maps are stored using the state map's point ID.
    let filepath = `${ALERT_STATE_MAPS_DIRECTORY}/${stateMap.pointId}.json`;
    log('DEBUG', `[${stateMap.pointId}] deleting state map ${filepath}`);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
};

const deleteAlertStateMapFromArchive = (stateMapId) => {    
    // Archived state maps are stored using the state map's ID (state map ID also used as alert ID)
    let filepath = `${ALERT_STATE_MAPS_INACTIVE_DIRECTORY}/${stateMapId}.json`;
    log('DEBUG', `deleting state map from archive: ${filepath}`);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
};

/**
 * Write the point to alert rule mappings to the file system.
 */
const persistPointToAlertRuleMappings = () => {    
    log('DEBUG', `persisting point to alert rule mappings`);
    fs.writeFileSync(ALERT_RULES_MAPPING_FILE, JSON.stringify(alertRuleMappings, null, 4));
};

/**
 * Write the point to hardware alert rule mappings to the file system.
 */
const persistPointToHardwareAlertRuleMappings = () => {    
    log('DEBUG', `persisting point to hardware alert rule mappings`);
    fs.writeFileSync(HW_ALERT_RULES_MAPPING_FILE, JSON.stringify(hardwareAlertRuleMappings, null, 4));
};

/**
 * Write the the alert rule to the file system.
 */
const persistAlertRule = (alertRule) => {    
    alertRuleCache[alertRule.id] = alertRule;
    const filepath = `${ALERT_RULES_DIRECTORY}/${alertRule.id}.json`;
    log('DEBUG', `persisting alert rule: ${filepath}`);
    fs.writeFileSync(filepath, JSON.stringify(alertRule, null, 4));
};

/**
 * Load the contents of a file containing JSON.
 * @param {string} filepath The path to the file.
 * @returns An object with the contents of the file.  If the file does not exist this will return null.
 */
const parseJsonFile = (filepath) => {
    log('TRACE', `loading JSON file ${filepath}`);
    if (!fs.existsSync(filepath)) {
        log('TRACE', `File does not exist.`);
        return null;
    }
    const data = fs.readFileSync(filepath);
    try {
        return JSON.parse(data);
    } catch (err) {
        log('ERROR', `Exception caught parsing contents of file '${filepath}': ${err}`);
        return null;
    }
};

/**
 * Determine if debug log level is enabled.
 * @returns {boolean} True if debug is enabled; otherwise false.
 */
const isDebugLogLevel = () => {
    return (LOG_LEVELS.indexOf(logLevel) >= LOG_LEVELS.indexOf('DEBUG'));
}

/**
 * Write a message to the log file.
 * @param {string} level The level at which the message is to be logged.
 * @param {string} message The message to log.
 * @returns 
 */
const log = (level, message) => {    
    // if (LOG_LEVELS.indexOf(logLevel) < LOG_LEVELS.indexOf(level)) return;
    const now = new Date();
    const date = `${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getDate().toString().padStart(2, "0")}/${now.getFullYear()}`;
    const time = `${now.toTimeString().substring(0, 8)}.${now.getMilliseconds().toString().padStart(3, "0")}`;    
    let lineNumber = '?';
    try {
        let e = new Error();
        let entries = e.stack.split('\n');
        // First entry is 'Error', 2nd is entry for log function, 3rd is the entry we want
        if (entries.length >= 3) {
            let entry = entries[2].replace('(', '').replace(')', '');
            lineNumber = entry.substring(entry.lastIndexOf('\\') + 1).split(':')[1];
        }
    }
    catch (err) {}
    // if (level === LOG_LEVELS[0])
    //     console.error(`${date} ${time} ${level} [alertStateMachine:${lineNumber}] ${message}`);
    // else
        console.log(`${date} ${time} ${level} [alertStateMachine:${lineNumber}] ${message}`);
};

const initialize = () => {
    // Make sure that the directory structure exists.
    fs.mkdirSync(ALERT_RULES_DIRECTORY, { recursive: true });
    fs.mkdirSync(ALERT_STATE_MAPS_INACTIVE_DIRECTORY, { recursive: true });
    
    alertRuleMappings = parseJsonFile(ALERT_RULES_MAPPING_FILE);
    if (alertRuleMappings == null) alertRuleMappings = {};
    if (isDebugLogLevel()) 
        log('DEBUG', `loaded alert rule mappings == ${JSON.stringify(alertRuleMappings, null, 4)}`);
    
    hardwareAlertRuleMappings = parseJsonFile(HW_ALERT_RULES_MAPPING_FILE);
    if (hardwareAlertRuleMappings == null) hardwareAlertRuleMappings = {};
    if (isDebugLogLevel()) 
        log('DEBUG', `loaded hw fault alert rule mappings == ${JSON.stringify(hardwareAlertRuleMappings, null, 4)}`);
};

////////////////////////////////////////////////////////////////////////////////////////////////////
// Actions to perform on start up.
////////////////////////////////////////////////////////////////////////////////////////////////////

if (alertRuleMappings == null || hardwareAlertRuleMappings == null) {
    initialize();
}