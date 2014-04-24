
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs");


exports.status = function(pio, state) {

    return pio.API.Q.fcall(function() {

        if (!state["pio.cli.local"].serviceSelector) {
            return pio.API.Q.resolve({});
        }

        ASSERT.equal(typeof state["pio.service.deployment"].path, "string", "'state[pio.service.deployment].path' must be set to a string!");
        ASSERT.equal(typeof state["pio.service.deployment"].env, "object", "'state[pio.service.deployment].env' must be set to an object!");

        var commands = [];
        commands.push('. /opt/bin/activate.sh');
        for (var name in state["pio.service.deployment"].env) {
            commands.push('export ' + name + '="' + state["pio.service.deployment"].env[name] + '"');
        }
        commands.push('export PIO_SCRIPTS_PATH="' + PATH.join(state["pio.service.deployment"].path, "live/scripts") + '"');
        commands.push('sh $PIO_SCRIPTS_PATH/status.sh');

		return pio._state["pio.deploy"]._call("_runCommands", {
            commands: commands,
            cwd: PATH.join(state["pio.service.deployment"].path, "live", "install")
        }).then(function(response) {
            if (!response) {
                throw new Error("Remote commands exited with no response!");
            }
            if (response.code !== 0) {
                throw new Error("Remote commands exited with code: " + response.code);
            }
            if (!response.objects || !response.objects.status) {
                throw new Error('Status response does not include a `<wf name="status">{...}</wf>` wildfire response!');
            }
			return {
				"pio.service.status": {
					"response": response.objects.status
				}
			};
        });
    });
}
