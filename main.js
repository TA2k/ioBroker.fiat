"use strict";

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const axiosCookieJarSupport = require("axios-cookiejar-support").default;
const tough = require("tough-cookie");
const crypto = require("crypto");
const aws4 = require("aws4");
const { extractKeys } = require("./lib/extractKeys");
// Load your modules here, e.g.:
// const fs = require("fs");

class Fiat extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "fiat",
        });
        this.on("ready", this.onReady.bind(this));
        // this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        axiosCookieJarSupport(axios);
        this.cookieJar = new tough.CookieJar();

        this.idArray = [];
        this.refreshTokenInterval = null;
        this.appUpdateInterval = null;
        this.reLoginTimeout = null;
        this.extractKeys = extractKeys;
        this.setState("info.connection", false, true);
        this.login()
            .then(() => {
                this.setState("info.connection", true, true);
                this.log.info("Login successful");
                this.getVehicles()
                    .then(() => {
                        this.idArray.forEach((vin) => {
                            this.getVehicleStatus(vin, "/v2/accounts/" + this.UID + "/vehicles/" + vin + "/status", "status").catch(() => {
                                this.log.error("get vehicles status failed");
                            });
                            this.getVehicleStatus(vin, "/v1/accounts/" + this.UID + "/vehicles/" + vin + "/location/lastknown", "location").catch(() => {
                                this.log.error("get vehicles location failed");
                            });
                            this.getVehicleStatus(vin, "/v1/accounts/" + this.UID + "/vehicles/" + vin + "/vhr", "vhr").catch(() => {
                                this.log.error("get vehicles vhr failed");
                            });
                        });
                        this.appUpdateInterval = setInterval(() => {
                            this.idArray.forEach((vin) => {
                                this.getVehicleStatus(vin, "/v2/accounts/" + this.UID + "/vehicles/" + vin + "/status", "status").catch(() => {
                                    this.log.error("get vehicles status failed");
                                });
                                this.getVehicleStatus(vin, "/v1/accounts/" + this.UID + "/vehicles/" + vin + "/location/lastknown", "location").catch(() => {
                                    this.log.error("get vehicles location failed");
                                });
                                this.getVehicleStatus(vin, "/v1/accounts/" + this.UID + "/vehicles/" + vin + "/vhr", "vhr").catch(() => {
                                    this.log.error("get vehicles vhr failed");
                                });
                            });
                        }, this.config.interval * 60 * 1000);
                    })
                    .catch(() => {
                        this.log.error("get vehicles failed");
                    });
            })
            .catch(() => {
                this.log.error("Login failed");
                this.setState("info.connection", false, true);
            });
    }

    login() {
        return new Promise((resolve, reject) => {
            axios({
                method: "get",
                jar: this.cookieJar,
                withCredentials: true,
                url: "https://loginmyuconnect.fiat.com/accounts.webSdkBootstrap?apiKey=3_mOx_J2dRgjXYCdyhchv3b5lhi54eBcdCTX4BI8MORqmZCoQWhA0mV2PTlptLGUQI&pageURL=https%3A%2F%2Fmyuconnect.fiat.com%2Fde%2Fde%2Fvehicle-services&sdk=js_latest&sdkBuild=12234&format=json",
                headers: {
                    accept: "*/*",
                    origin: "https://myuconnect.fiat.com",
                    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
                    "accept-language": "de-de",
                    referer: "https://myuconnect.fiat.com/de/de/vehicle-services",
                },
            })
                .then((response) => {
                    if (!response.data) {
                        this.log.error("first page failed");
                        reject();
                        return;
                    }
                    this.log.debug(JSON.stringify(response.data));

                    axios({
                        method: "post",
                        jar: this.cookieJar,
                        withCredentials: true,
                        url: "https://loginmyuconnect.fiat.com/accounts.login",
                        headers: {
                            accept: "*/*",
                            "content-type": "application/x-www-form-urlencoded",
                            origin: "https://myuconnect.fiat.com",
                            "accept-language": "de-de",
                            "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
                            referer: "https://myuconnect.fiat.com/de/de/login",
                        },
                        data: [
                            "loginID=" + this.config.user,
                            "password=" + this.config.password,
                            "sessionExpiration=7776000",
                            "targetEnv=jssdk",
                            "include=profile,data,emails,subscriptions,preferences,",
                            "includeUserInfo=true",
                            "loginMode=standard",
                            "lang=de0de",
                            'riskContext={"b0":52569,"b2":8,"b5":1}',
                            "APIKey=3_mOx_J2dRgjXYCdyhchv3b5lhi54eBcdCTX4BI8MORqmZCoQWhA0mV2PTlptLGUQI",
                            "source=showScreenSet",
                            "sdk=js_latest",
                            "authMode=cookie",
                            "pageURL=https://myuconnect.fiat.com/de/de/login",
                            "sdkBuild=12234",
                            "format=json",
                        ].join("&"),
                    })
                        .then((response) => {
                            if (!response.data) {
                                this.log.error("Login failed maybe incorrect login information");
                                reject();
                                return;
                            }
                            this.log.debug(JSON.stringify(response.data));
                            if (!response.data.sessionInfo) {
                                this.log.error("sessionInfo missing");
                                reject();
                                return;
                            }
                            this.loginToken = response.data.sessionInfo.login_token;
                            this.UID = response.data.userInfo.UID;
                            this.extractKeys(this, "general", response.data);
                            axios({
                                method: "get",
                                jar: this.cookieJar,
                                withCredentials: true,
                                url:
                                    "https://loginmyuconnect.fiat.com/accounts.getJWT?fields=profile.firstName%2Cprofile.lastName%2Cprofile.email%2Ccountry%2Clocale%2Cdata.disclaimerCodeGSDP%2Cdata.GSDPisVerified&APIKey=3_mOx_J2dRgjXYCdyhchv3b5lhi54eBcdCTX4BI8MORqmZCoQWhA0mV2PTlptLGUQI&sdk=js_latest&login_token=" +
                                    this.loginToken +
                                    "&authMode=cookie&pageURL=https%3A%2F%2Fmyuconnect.fiat.com%2Fde%2Fde%2Fdashboard&sdkBuild=12234&format=json",
                                headers: {
                                    accept: "*/*",
                                    origin: "https://myuconnect.fiat.com",
                                    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
                                    "accept-language": "de-de",
                                    referer: "https://myuconnect.fiat.com/de/de/dashboard",
                                },
                            })
                                .then((response) => {
                                    if (!response.data) {
                                        this.log.error("JWT failed maybe incorrect login information");
                                        reject();
                                        return;
                                    }
                                    this.log.debug(JSON.stringify(response.data));
                                    if (!response.data.id_token) {
                                        this.log.error("id_token missing");
                                        reject();
                                        return;
                                    }
                                    this.idToken = response.data.id_token;
                                    axios({
                                        method: "post",
                                        url: "https://authz.sdpr-01.fcagcv.com/v2/cognito/identity/token",
                                        headers: {
                                            "content-type": "application/json",
                                            "x-clientapp-version": "1.0",
                                            clientrequestid: this.randomString(16),
                                            accept: "*/*",
                                            locale: "de_de",
                                            "x-api-key": "qLYupk65UU1tw2Ih1cJhs4izijgRDbir2UFHA3Je",
                                            "accept-language": "de-de",
                                            origin: "https://myuconnect.fiat.com",
                                            "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
                                            referer: "https://myuconnect.fiat.com/de/de/dashboard",
                                            "x-originator-type": "web",
                                        },
                                        data: JSON.stringify({
                                            gigya_token: this.idToken,
                                        }),
                                    })
                                        .then((response) => {
                                            if (!response.data) {
                                                this.log.error("fca failed maybe incorrect login information");
                                                reject();
                                                return;
                                            }
                                            this.log.debug(JSON.stringify(response.data));
                                            if (!response.data.Token) {
                                                this.log.error("Token missing");
                                                reject();
                                                return;
                                            }
                                            this.token = response.data.Token;
                                            this.identityId = response.data.IdentityId;
                                            const data = JSON.stringify({
                                                IdentityId: this.identityId,
                                                Logins: {
                                                    "cognito-identity.amazonaws.com": this.token,
                                                },
                                            });
                                            axios({
                                                method: "post",
                                                url: "https://cognito-identity.eu-west-1.amazonaws.com/",
                                                headers: {
                                                    "content-type": "application/x-amz-json-1.1",
                                                    accept: "*/*",
                                                    "x-amz-user-agent": "aws-sdk-js/2.283.1 callback",
                                                    "accept-language": "de-de",
                                                    origin: "https://myuconnect.fiat.com",
                                                    "x-amz-content-sha256": crypto.createHash("sha256").update(data).digest("hex"),
                                                    "user-agent":
                                                        "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
                                                    referer: "https://myuconnect.fiat.com/de/de/dashboard",
                                                    "x-amz-target": "AWSCognitoIdentityService.GetCredentialsForIdentity",
                                                },
                                                data: data,
                                            })
                                                .then((response) => {
                                                    if (!response.data) {
                                                        this.log.error("amz failed maybe incorrect login information");
                                                        reject();
                                                        return;
                                                    }
                                                    this.log.debug(JSON.stringify(response.data));
                                                    this.amz = response.data;
                                                    if (!this.amz.Credentials) {
                                                        this.log.error("Credentials missing");
                                                        reject();
                                                        return;
                                                    }

                                                    this.refreshTokenInterval = setInterval(() => {
                                                        this.login().catch((error) => {
                                                            this.log.error("Refresh token failed");
                                                        });
                                                    }, 23.5 * 60 * 60 * 1000);
                                                    resolve();
                                                })
                                                .catch((error) => {
                                                    this.log.error(error);
                                                    this.log.error("amz Token failed");
                                                    error.response && this.log.error(JSON.stringify(error.response.data));
                                                    reject();
                                                });
                                        })
                                        .catch((error) => {
                                            this.log.error(error);
                                            this.log.error("fca Token failed");
                                            error.response && this.log.error(JSON.stringify(error.response.data));
                                            reject();
                                        });
                                })
                                .catch((error) => {
                                    this.log.error(error);
                                    this.log.error("JWT Token failed");
                                    error.response && this.log.error(JSON.stringify(error.response.data));
                                    reject();
                                });
                        })
                        .catch((error) => {
                            this.log.error(error);
                            this.log.error("Login failed");
                            error.response && this.log.error(JSON.stringify(error.response.data));
                            reject();
                        });
                })
                .catch((error) => {
                    this.log.error(error);
                    this.log.error("Login failed");
                    error.response && this.log.error(JSON.stringify(error.response.data));
                    reject();
                });
        });
    }
    getVehicles() {
        return new Promise((resolve, reject) => {
            const headers = {
                Host: "channels.sdpr-01.fcagcv.com",
                "content-type": "application/json",
                "x-clientapp-version": "1.0",
                clientrequestid: this.randomString(16),
                accept: "application/json, text/plain, */*",
                "x-amz-date": this.amzDate(),
                "x-amz-security-token": this.amz.Credentials.SessionToken,
                locale: "de_de",
                "x-api-key": "qLYupk65UU1tw2Ih1cJhs4izijgRDbir2UFHA3Je",
                "accept-language": "de-de",
                "x-clientapp-name": "CWP",
                origin: "https://myuconnect.fiat.com",
                "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
                referer: "https://myuconnect.fiat.com/de/de/dashboard",
                "x-originator-type": "web",
            };
            const signed = aws4.sign(
                {
                    host: "channels.sdpr-01.fcagcv.com",
                    path: "/v4/accounts/" + this.UID + "/vehicles?stage=ALL",
                    service: "execute-api",
                    method: "GET",
                    region: "eu-west-1",
                    headers: headers,
                },
                { accessKeyId: this.amz.Credentials.AccessKeyId, secretAccessKey: this.amz.Credentials.SecretKey }
            );
            this.log.debug(signed);
            headers["Authorization"] = signed.headers["Authorization"];
            axios({
                method: "get",
                host: "channels.sdpr-01.fcagcv.com",
                jar: this.cookieJar,
                withCredentials: true,
                url: "https://channels.sdpr-01.fcagcv.com/v4/accounts/" + this.UID + "/vehicles?stage=ALL",
                headers: headers,
            })
                .then((response) => {
                    if (!response.data) {
                        this.log.error("Get vehicles failed");
                        reject();
                        return;
                    }
                    this.log.debug(JSON.stringify(response.data));
                    response.data.vehicles.forEach(async (element) => {
                        this.idArray.push(element.vin);
                        await this.setObjectNotExistsAsync(element.vin, {
                            type: "device",
                            common: {
                                name: element.modelDescription,
                                role: "indicator",
                            },
                            native: {},
                        });

                        this.extractKeys(this, element.vin + ".general", element, "service");
                        resolve();
                    });
                })
                .catch((error) => {
                    this.log.error(error);
                    this.log.error("GetVehicles failed");
                    error.response && this.log.error(JSON.stringify(error.response.data));
                    reject();
                });
        });
    }
    getVehicleStatus(vin, url, path) {
        return new Promise((resolve, reject) => {
            const headers = {
                Host: "channels.sdpr-01.fcagcv.com",
                "content-type": "application/json",
                "x-clientapp-version": "1.0",
                clientrequestid: this.randomString(16),
                accept: "application/json, text/plain, */*",
                "x-amz-date": this.amzDate(),
                "x-amz-security-token": this.amz.Credentials.SessionToken,
                locale: "de_de",
                "x-api-key": "qLYupk65UU1tw2Ih1cJhs4izijgRDbir2UFHA3Je",
                "accept-language": "de-de",
                "x-clientapp-name": "CWP",
                origin: "https://myuconnect.fiat.com",
                "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
                referer: "https://myuconnect.fiat.com/de/de/dashboard",
                "x-originator-type": "web",
            };
            const signed = aws4.sign(
                {
                    host: "channels.sdpr-01.fcagcv.com",

                    path: url,
                    service: "execute-api",
                    method: "GET",
                    region: "eu-west-1",
                    headers: headers,
                },
                { accessKeyId: this.amz.Credentials.AccessKeyId, secretAccessKey: this.amz.Credentials.SecretKey }
            );
            headers["Authorization"] = signed.headers["Authorization"];
            axios({
                method: "get",
                host: "channels.sdpr-01.fcagcv.com",
                jar: this.cookieJar,
                withCredentials: true,
                url: "https://channels.sdpr-01.fcagcv.com" + url,
                headers: headers,
            })
                .then((response) => {
                    if (!response.data) {
                        this.log.error("Get vehicles failed: " + path);
                        reject();
                        return;
                    }
                    this.log.debug(JSON.stringify(response.data));
                    this.extractKeys(this, vin + "." + path, response.data, "service");
                    resolve();
                })
                .catch((error) => {
                    if (error.response && error.response.status === 403) {
                        this.log.info("403 Error relogin in 30 seconds");
                        this.reLoginTimeout = this.setTimeout(() => {
                            this.login();
                        }, 1000 * 30);
                    }
                    this.log.error(error);
                    this.log.error("GetVehicles status failed" + path);
                    error.response && this.log.error(JSON.stringify(error.response.data));
                    reject(error);
                });
        });
    }

    randomString(length) {
        let result = "";
        const characters = "abcdefghijklmnopqrstuvwxyz0123456789";
        const charactersLength = characters.length;
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result;
    }

    amzDate() {
        return new Date().toISOString().slice(0, 20).replace(/-/g, "").replace(/:/g, "").replace(/\./g, "") + "Z";
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            callback();
            this.clearInterval(this.refreshTokenInterval);
            this.clearInterval(this.appUpdateInterval);
            this.clearInterval(this.reLoginTimeout);
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Fiat(options);
} else {
    // otherwise start the instance directly
    new Fiat();
}
