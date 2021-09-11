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
const Json2iob = require("./lib/json2iob");
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
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        axiosCookieJarSupport(axios);
        this.cookieJar = new tough.CookieJar();

        if (this.config.interval < 0.5) {
            this.log.info("Set interval to minimum 0.5");
            this.config.interval = 0.5;
        }
        this.idArray = [];
        this.refreshTokenInterval = null;
        this.appUpdateInterval = null;
        this.reLoginTimeout = null;
        this.json2iob = new Json2iob(this);
        this.setState("info.connection", false, true);
        this.subscribeStates("*");
        this.login()
            .then(() => {
                this.setState("info.connection", true, true);
                this.log.info("Login successful");
                this.refreshTokenInterval = setInterval(() => {
                    this.login().catch((error) => {
                        this.log.error("Refresh token failed");
                    });
                }, 0.9 * 60 * 60 * 1000);
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
                            this.getVehicleStatus(vin, "/v1/accounts/" + this.UID + "/vehicles/" + vin + "/svla/status", "svla").catch(() => {
                                this.log.error("get vehicles svla failed");
                            });

                            // this.getVehicleStatus(vin, "/v1/accounts/" + this.UID + "/vehicles/" + vin + "/phev/chargeschedule", "chargeschedule").catch(() => {
                            //     this.log.error("get vehicles remote history failed");
                            // });
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
                                this.getVehicleStatus(vin, "/v1/accounts/" + this.UID + "/vehicles/" + vin + "/svla/status", "svla").catch(() => {
                                    this.log.error("get vehicles svla failed");
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
                ignoreCookieErrors: true,
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
                            this.json2iob.parse("general", response.data);
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
                            this.log.error("Login failed #2");
                            error.response && this.log.error(JSON.stringify(error.response.data));
                            reject();
                        });
                })
                .catch((error) => {
                    this.log.error(error);
                    this.log.error("Login failed #1");
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
                        await this.setObjectNotExistsAsync(element.vin + ".remote", {
                            type: "channel",
                            common: {
                                name: "Remote Controls",
                                role: "indicator",
                            },
                            native: {},
                        });
                        const remoteArray = [
                            { command: "VF", name: "Update Location" },
                            { command: "RDU", name: "Unlock" },
                            { command: "RDL", name: "Lock" },
                            { command: "ROLIGHTS", name: "Lights" },
                            { command: "ROHVACON", name: "AC On" },
                            { command: "ROHVACOFF", name: "AC Off" },
                            { command: "ROTRUNKLOCK", name: "Trunk Lock" },
                            { command: "ROTRUNKUNLOCK", name: "Trunk Unlock" },
                            { command: "REON", name: "Engine on" },
                            { command: "REOFF", name: "Engine off" },
                            { command: "HBLF", name: "Locate Horn Lights" },
                            { command: "TA", name: "Theft Alarm Suppress" },
                            { command: "CNOW", name: "Charge Now" },
                            { command: "DEEPREFRESH", name: "Deep refresh charging state" },
                            { command: "ROPRECOND", name: "Precondition/Klima" },
                        ];
                        remoteArray.forEach((remote) => {
                            this.setObjectNotExists(element.vin + ".remote." + remote.command, {
                                type: "state",
                                common: {
                                    name: remote.name,
                                    type: "boolean",
                                    role: "boolean",
                                    write: true,
                                },
                                native: {},
                            });
                        });

                        this.json2iob.parse(element.vin + ".general", element, { preferedArrayName: "service" });
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
    getVehicleStatus(vin, url, path, data) {
        return new Promise((resolve, reject) => {
            let method = "GET";
            if (data) {
                method = "POST";
            }
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
                    body: data,
                    path: url,
                    service: "execute-api",
                    method: method,
                    region: "eu-west-1",
                    headers: headers,
                },
                { accessKeyId: this.amz.Credentials.AccessKeyId, secretAccessKey: this.amz.Credentials.SecretKey }
            );
            headers["Authorization"] = signed.headers["Authorization"];
            axios({
                method: method,
                host: "channels.sdpr-01.fcagcv.com",
                jar: this.cookieJar,
                withCredentials: true,
                url: "https://channels.sdpr-01.fcagcv.com" + url,
                headers: headers,
                data: data,
            })
                .then((response) => {
                    if (!response.data) {
                        this.log.error("Get vehicles failed: " + path);
                        reject();
                        return;
                    }
                    this.log.debug(JSON.stringify(response.data));
                    if (path) {
                        this.json2iob.parse(vin + "." + path, response.data, { preferedArrayName: "itemKey" });
                    }
                    resolve(response.data);
                })
                .catch((error) => {
                    if (error.response && error.response.status === 403) {
                        error.response && this.log.debug(JSON.stringify(error.response.data));
                        this.log.info(path + " receive 403 error. Relogin in 30 seconds");
                        clearTimeout(this.reLoginTimeout);
                        this.reLoginTimeout = setTimeout(() => {
                            this.login().catch(() => {
                                this.log.error("Relogin failed restart adapter");
                                this.reLoginTimeout = setTimeout(() => {
                                    this.restart();
                                }, 1000 * 60 * 5);
                            });
                        }, 1000 * 30);
                        reject();
                        return;
                    }
                    this.log.error(error);
                    this.log.error("Request failed: " + path);
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
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        try {
            if (state) {
                if (!state.ack) {
                    const vin = id.split(".")[2];
                    const command = id.split(".")[4];
                    let action = "remote";
                    if (command === "VF") {
                        action = "location";
                    }
                    if (command === "DEEPREFRESH") {
                        action = "ev";
                    }

                    if (id.indexOf(".remote.")) {
                        this.receivePinAuth()
                            .then(() => {
                                this.getVehicleStatus(
                                    vin,
                                    "/v1/accounts/" + this.UID + "/vehicles/" + vin + "/" + action,
                                    null,
                                    JSON.stringify({
                                        command: command,
                                        pinAuth: this.pinAuth,
                                    })
                                )
                                    .then((data) => {
                                        if (data.responseStatus !== "pending") {
                                            this.log.warn(JSON.stringify(data));
                                        }
                                        this.updateTimeout = setTimeout(() => {
                                            this.getVehicleStatus(vin, "/v1/accounts/" + this.UID + "/vehicles/" + vin + "/location/lastknown", "location").catch(() => {
                                                this.log.error("get vehicles location failed");
                                            });
                                            this.getVehicleStatus(vin, "/v2/accounts/" + this.UID + "/vehicles/" + vin + "/status", "status").catch(() => {
                                                this.log.error("get vehicles status failed");
                                            });
                                        }, 10 * 1000);
                                    })
                                    .catch(() => {
                                        this.log.error("Failed to set remote");
                                    });
                            })
                            .catch((error) => {
                                this.log.error("Failed to authenticate pin");
                                this.log.error(error);
                            });
                    }
                }
            }
        } catch (err) {
            this.log.error("Error in OnStateChange: " + err);
        }
    }

    receivePinAuth() {
        return new Promise((resolve, reject) => {
            if (!this.config.pin) {
                this.log.warn("No pin in instance settings");
                reject();
                return;
            }

            const data = JSON.stringify({ pin: Buffer.from(this.config.pin).toString("base64") });
            const url = "/v1/accounts/" + this.UID + "/ignite/pin/authenticate";
            const method = "POST";
            const headers = {
                Host: "mfa.fcl-01.fcagcv.com",
                "sec-ch-ua": '"Chromium";v="91", " Not A;Brand";v="99", "Google Chrome";v="91"',
                clientrequestid: this.randomString(16),
                "content-type": "application/json",
                requestid: this.randomString(16),
                accept: "application/json, text/plain, */*",
                "x-amz-date": this.amzDate(),
                "x-amz-security-token": this.amz.Credentials.SessionToken,
                locale: "de_de",
                "x-api-key": "JWRYW7IYhW9v0RqDghQSx4UcRYRILNmc8zAuh5ys",
                "accept-language": "de-de",
                origin: "https://myuconnect.fiat.com",
                "sec-fetch-site": "cross-site",
                "sec-fetch-mode": "cors",
                "sec-fetch-dest": "empty",
                referer: "https://myuconnect.fiat.com/",
                "accept-language": "de,en;q=0.9",
                "x-originator-type": "web",
                "sec-ch-ua-mobile": "?0",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.164 Safari/537.36",
            };
            const signed = aws4.sign(
                {
                    host: "mfa.fcl-01.fcagcv.com",
                    body: data,
                    path: url,
                    service: "execute-api",
                    method: method,
                    region: "eu-west-1",
                    headers: headers,
                },
                { accessKeyId: this.amz.Credentials.AccessKeyId, secretAccessKey: this.amz.Credentials.SecretKey }
            );
            headers["Authorization"] = signed.headers["Authorization"];
            axios({
                method: method,
                host: "mfa.fcl-01.fcagcv.com",
                jar: this.cookieJar,
                withCredentials: true,
                url: "https://mfa.fcl-01.fcagcv.com" + url,
                headers: headers,
                data: data,
            })
                .then((response) => {
                    if (!response.data) {
                        this.log.error("Get pin failed: ");
                        reject();
                        return;
                    }
                    this.log.debug(JSON.stringify(response.data));

                    this.pinAuth = response.data.token;

                    resolve(response.data);
                })
                .catch((error) => {
                    if (error.response && error.response.status === 403) {
                        if (error.response && error.response.data && error.response.data.name === "INVALID_PIN") {
                            this.log.error(JSON.stringify(error.response.data));
                            reject();
                            return;
                        }

                        error.response && this.log.debug(JSON.stringify(error.response.data));
                        this.log.info(path + " receive 403 error. Relogin in 30 seconds");
                        clearTimeout(this.reLoginTimeout);
                        this.reLoginTimeout = setTimeout(() => {
                            this.login().catch(() => {
                                this.log.error("Relogin failed restart adapter");
                                this.reLoginTimeout = setTimeout(() => {
                                    this.restart();
                                }, 1000 * 60 * 5);
                            });
                        }, 1000 * 30);
                        reject();
                        return;
                    }
                    this.log.error(error);
                    this.log.error("get pin failed");
                    error.response && this.log.error(JSON.stringify(error.response.data));
                    reject(error);
                });
        });
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            callback();
            clearInterval(this.refreshTokenInterval);
            clearInterval(this.appUpdateInterval);
            clearTimeout(this.reLoginTimeout);
        } catch (e) {
            callback();
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
