
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs");
const CRYPTO = require("crypto");


exports.ensure = function(pio, state) {

    return pio.API.Q.fcall(function() {

        var serviceId = state["pio.cli.local"].serviceSelector;

        if (!serviceId) {
            return pio.API.Q.resolve({});
        }

        ASSERT.equal(typeof state["pio.vm"].prefixPath, "string", "'state[pio.vm].prefixPath' must be set to a string!");
        ASSERT.equal(typeof state["pio.vm"].ip, "string", "'state[pio.vm].ip' must be set to a string!");
        ASSERT.equal(typeof state["pio"].hostname, "string", "'state[pio].hostname' must be set to a string!");
        ASSERT.equal(typeof state["pio"].servicesPath, "string", "'state[pio].servicesPath' must be set to a string!");


        if (!state["pio.services"].services[serviceId]) {
            throw "No service found for selector '" + serviceId + "'!";
        }

        var serviceDescriptor = pio.API.DEEPCOPY(state["pio.services"].services[serviceId].descriptor);

        serviceDescriptor.enabled = state["pio.services"].services[serviceId].enabled;
        serviceDescriptor.group = state["pio.services"].services[serviceId].group;
        serviceDescriptor.id = serviceId;
        serviceDescriptor.path = state["pio.services"].services[serviceId].path;
        serviceDescriptor.originalPath = serviceDescriptor.path;

        // TODO: Use pinf-config conventions to resolve these.
        var serviceDescriptorStr = JSON.stringify(serviceDescriptor);
        serviceDescriptorStr = serviceDescriptorStr.replace(/\{\{config.pio\.hostname\}\}/g, state["pio"].hostname);
        serviceDescriptor = JSON.parse(serviceDescriptorStr);


        //-----
        // WARNING: This is something that is going to impact a lot once decided upon.
        // TODO: Not to sure about this. Should use JS expressions that operate on JSON above itself?
        //       If so only with restricted capabilities. But config for different environments
        //       should come from *profiles* and config inheritance and package mappings and mapping overlays
        //       should be used to eliminate different content sections.
//            serviceDescriptor.config = pio.API.DEEPMERGE(serviceDescriptor.config || {}, serviceDescriptor["config[live]"] || {});
//            delete serviceDescriptor["config[live]"];
/*        
        serviceDescriptor.config = DEEPMERGE(serviceDescriptor.config || {}, serviceDescriptor["config[cloud=" + self._config.cloud + "]"] || {});
        for (var key in serviceDescriptor.config) {
            if (/^config\[cloud=.+\]$/.test(key)) {
                delete serviceDescriptor[key];
            }
        }
*/
//            serviceDescriptor.config = pio.API.DEEPMERGE(serviceDescriptor.config || {}, serviceDescriptor["config[" + state["pio"].hostname + "]"] || {});
//            delete serviceDescriptor["config[" + state["pio"].hostname + "]"];
        //-----


        // The unique universal identifier for the service (codebase + instance)
        // POLICY: The same `uuid` must be used for the same service on each vm in a cluster.
        //         This is implied since the value is kept in the `pio.service` namespace.
        serviceDescriptor.uuid = pio._instanceHash(["service-uuid", serviceDescriptor.id]);

        function readServiceDescriptor() {
            var path = PATH.join(serviceDescriptor.path, "package.json");
            return pio.API.Q.denodeify(function(callback) {
                return FS.exists(path, function(exists) {
                    if (!exists) return callback(null, null);
                    return pio.API.FS.readJson(path, callback);
                });
            })();
        }
        function readSourceDescriptor() {
            var path = PATH.join(serviceDescriptor.path, "source/package.json");
            return pio.API.Q.denodeify(function(callback) {
                return FS.exists(path, function(exists) {
                    if (!exists) return callback(null, null);
                    return pio.API.FS.readJson(path, callback);
                });
            })();
        }
        return readServiceDescriptor().then(function(_serviceDescriptor) {

            return readSourceDescriptor().then(function(_sourceDescriptor) {

                var serviceDeploymentDescriptor = {};

                if (_sourceDescriptor) {
                    serviceDescriptor.descriptor = _serviceDescriptor || {};
                    serviceDescriptor.sourceDescriptor = _sourceDescriptor || {};
                } else {
                    serviceDescriptor.descriptor = {
                        config: (_serviceDescriptor && _serviceDescriptor.config) || {},
                        env: (_serviceDescriptor && _serviceDescriptor.env) || {}
                    };
                    serviceDescriptor.sourceDescriptor = _serviceDescriptor || {};
                }
                serviceDeploymentDescriptor.path = PATH.join(state["pio.vm"].prefixPath, "services", serviceDescriptor.id);


                function mergeEnv(ours, parent) {
                    parent = pio.API.DEEPCOPY(parent);
                    var ourPATH = ours.PATH;
                    ours = pio.API.DEEPMERGE(ours, parent);
                    if (typeof ourPATH !== "undefined") {
                        ours.PATH = ourPATH;
                    }
                    return ours;
                }

                serviceDeploymentDescriptor.env = mergeEnv(serviceDescriptor.env || {}, pio._config.env);

                serviceDeploymentDescriptor.env.PIO_PUBLIC_IP = state["pio.vm"].ip;
                serviceDeploymentDescriptor.env.PIO_BIN_PATH = PATH.join(state["pio.vm"].prefixPath, "bin");
                serviceDeploymentDescriptor.env.PIO_SERVICE_ID = serviceDescriptor.id;
                serviceDeploymentDescriptor.env.PIO_SERVICE_ID_SAFE = serviceDeploymentDescriptor.env.PIO_SERVICE_ID.replace(/\./g, "-");
                serviceDeploymentDescriptor.env.PIO_SERVICE_OS_USER = state["pio.vm"].user;
                serviceDeploymentDescriptor.env.PIO_SERVICE_PATH = serviceDeploymentDescriptor.path;
                serviceDeploymentDescriptor.env.PIO_SERVICE_LOG_BASE_PATH = PATH.join(state["pio.vm"].prefixPath, "log", serviceDescriptor.id);
                serviceDeploymentDescriptor.env.PIO_SERVICE_RUN_BASE_PATH = PATH.join(state["pio.vm"].prefixPath, "run", serviceDescriptor.id);
                serviceDeploymentDescriptor.env.PIO_SERVICE_DATA_BASE_PATH = PATH.join(state["pio.vm"].prefixPath, "data", serviceDescriptor.id);

                // TODO: Pass these along in a backchannel unless declared in config.
                // TODO: Make env propagation more generic using new config module.
                if (serviceDeploymentDescriptor.env.AWS_ACCESS_KEY === "$AWS_ACCESS_KEY") {
                    serviceDeploymentDescriptor.env.AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY;
                }
                if (serviceDeploymentDescriptor.env.AWS_SECRET_KEY === "$AWS_SECRET_KEY") {
                    serviceDeploymentDescriptor.env.AWS_SECRET_KEY = process.env.AWS_SECRET_KEY;
                }

                if (serviceDescriptor.descriptor && serviceDescriptor.descriptor.env) {
                    serviceDeploymentDescriptor.env = pio.API.DEEPMERGE(serviceDescriptor.descriptor.env, serviceDeploymentDescriptor.env);
                }

                serviceDeploymentDescriptor["config.plugin"] = {};
                serviceDeploymentDescriptor["config.plugin~raw"] = {};

                // TODO: Pass raw along in abstracted object.
                for (var serviceId in state["pio.services"].services) {
                    if (
                        state["pio.services"].services[serviceId].descriptor["config.plugin"] &&
                        state["pio.services"].services[serviceId].descriptor["config.plugin"][serviceDescriptor.id]
                    ) {
                        serviceDeploymentDescriptor["config.plugin"][serviceId] = state["pio.services"].services[serviceId].descriptor["config.plugin"][serviceDescriptor.id];
                        serviceDeploymentDescriptor["config.plugin~raw"][serviceId] = state["pio.services"].services[serviceId].descriptor._raw["config.plugin"][serviceDescriptor.id];
                    }
                }
                // TODO: Use pinf-config conventions to resolve these.
                var pluginConfigStr = JSON.stringify(serviceDeploymentDescriptor["config.plugin"]);
                pluginConfigStr = pluginConfigStr.replace(/\{\{config.pio\.hostname\}\}/g, state["pio"].hostname);
                serviceDeploymentDescriptor["config.plugin"] = JSON.parse(pluginConfigStr);

                function generateFileInfo() {
                    var walker = new pio.API.FSWALKER.Walker(serviceDescriptor.path);
                    var opts = {};
                    opts.returnIgnoredFiles = true;
                    opts.includeDependencies = false;
                    opts.respectDistignore = false;
                    opts.respectNestedIgnore = true;
                    opts.excludeMtime = true;
                    return pio.API.Q.nbind(walker.walk, walker)(opts).then(function(fileinfo) {
                        var shasum = CRYPTO.createHash("sha1");
                        shasum.update(JSON.stringify(fileinfo[0]));
                        return {
                            checksum: shasum.digest("hex"),
                            fileinfo: fileinfo
                        };
                    });
                }

                return generateFileInfo().then(function(fileInfo) {

                    // Includes source, scripts and local tools for service.
                    // So anything related to a service for purpose of detecting changes and
                    // need to initiate sync of service components. Also used to version service.
                    serviceDescriptor.originalChecksum = fileInfo.checksum;

                    serviceDescriptor.status = "ready";
                    serviceDeploymentDescriptor.status = "ready";

                    var res =  {
                        "pio.service": serviceDescriptor,
                        "pio.service.deployment": serviceDeploymentDescriptor
                    };

                    if (serviceDescriptor.descriptor && serviceDescriptor.descriptor.config) {
                        res = pio.API.DEEPMERGE(serviceDescriptor.descriptor.config, res);
                    }
                    if (serviceDescriptor.config) {
                        res = pio.API.DEEPMERGE(res, serviceDescriptor.config);
                    }

                    var ServiceDescriptor = function (properties) {
                        for (var name in properties) {
                            this[name] = properties[name];
                        }
                    }
                    ServiceDescriptor.prototype = {
                        getFileInfo: function () {
                            return pio.API.Q.resolve(fileInfo.fileinfo);
                        }
                    };

                    res["pio.service"] = new ServiceDescriptor(res["pio.service"]);

                    return res;
                });
            });
        });
    });
}
