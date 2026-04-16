const PUBLIC_ACTIONS = new Set([
    "discover", "whois", "send_file", "submit_deliverable",
    "project_status",
    "task_update", "task_complete", "task_blocked",
    "asset_list", "asset_get",
    "post_to_thread",
]);
const PM_ONLY_ACTIONS = new Set([
    "project_create", "create_project_thread", "create_sub_thread",
    "task_assign", "task_reassign", "asset_publish",
]);
const SUPERUSER_ACTIONS = new Set(["read_file", "write_file", "restart"]);
export function checkPermission(action, config) {
    if (PUBLIC_ACTIONS.has(action))
        return true;
    if (PM_ONLY_ACTIONS.has(action))
        return config.isProjectManager === true;
    if (SUPERUSER_ACTIONS.has(action))
        return config.role === "superuser";
    return false;
}
export function assertPermission(action, config) {
    if (!checkPermission(action, config)) {
        if (PM_ONLY_ACTIONS.has(action)) {
            throw new Error(`STOP — "${action}" is PM-only. You are NOT the PM. Use bridge_submit_deliverable or bridge_send_file to send outputs to PM. DO NOT retry this tool.`);
        }
        throw new Error(`STOP — "${action}" requires superuser role (you have "${config.role}"). DO NOT retry this tool.`);
    }
}
