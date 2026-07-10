'use strict';

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const { HttpsCookieAgent } = require('http-cookie-agent/http');
const tough = require('tough-cookie');
const crypto = require('crypto');
const aws4 = require('aws4');
const Json2iob = require('json2iob');

class Fiat extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: 'fiat',
    });
    this.cookieJar = new tough.CookieJar();
    this.requestClient = axios.create({
      withCredentials: true,
      httpsAgent: new HttpsCookieAgent({
        cookies: {
          jar: this.cookieJar,
        },
      }),
    });

    this.json2iob = new Json2iob(this);
    this.idArray = [];
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Brand configuration aligned with py-uconnect / hass-uconnect and confirmed
    // against the official My Uconnect APK v1.99.701 (smali_classes4/.../MyUrlFactory.smali).
    // Single FIAT x-api-key works for both FIAT and Jeep on the EU stack.
    this.apiKey = '2wGyL6PHec9o1UeLPYpoYa1SkEWqeBur9bLsi24i';
    this.loginApiKey = '3_mOx_J2dRgjXYCdyhchv3b5lhi54eBcdCTX4BI8MORqmZCoQWhA0mV2PTlptLGUQI';
    this.myuUrl = 'myuconnect.fiat.com';
    this.loginUrl = 'loginmyuconnect.fiat.com';
    this.brandCode = 'FIAT';
    this.type = this.config.type || 'fiat';

    if (this.type === 'jeep') {
      this.loginApiKey = '3_ZvJpoiZQ4jT5ACwouBG5D1seGEntHGhlL0JYlZNtj95yERzqpH4fFyIewVMmmK7j';
      this.loginUrl = 'login.jeep.com';
      this.myuUrl = 'myuconnect.jeep.com';
      this.brandCode = 'REST';
    }

    if (this.config.interval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.interval = 0.5;
    }
    this.refreshTokenInterval = null;
    this.appUpdateInterval = null;
    this.reLoginTimeout = null;
    this.setState('info.connection', false, true);
    this.subscribeStates('*');

    try {
      await this.login();
    } catch {
      this.log.error('Login failed');
      this.setState('info.connection', false, true);
      return;
    }

    this.setState('info.connection', true, true);
    this.log.info('Login successful');
    this.refreshTokenInterval = setInterval(async () => {
      try {
        await this.login();
      } catch (error) {
        this.log.error('Refresh token failed');
        this.log.error(String(error));
      }
    }, 0.9 * 60 * 60 * 1000);

    try {
      await this.getVehicles();
    } catch {
      this.log.error('get vehicles failed');
      return;
    }

    await this.updateAllVehicles();
    this.appUpdateInterval = setInterval(() => {
      this.updateAllVehicles();
    }, this.config.interval * 60 * 1000);
  }

  /**
   * Per-command metadata for the FCA remote endpoints. Pulled from the official
   * My Uconnect APK 1.99.701 (smali_classes4/.../MyUrlFactory.smali) and
   * cross-checked against py-uconnect/py_uconnect/command.py:
   *
   *   /v1/.../remote/   – classic remote commands (lock, unlock, lights, ...)
   *   /v2/.../remote/   – HVAC, trunk, liftgate, cabin vent, target temperature
   *   /v1/.../location/ – location refresh (VF)
   *   /v1/.../ev/       – DEEPREFRESH (with v2 DEEPREFRESH2 fallback)
   *   /v1/.../ev/chargenow/ – CNOW (with v4 START_CHARGE fallback)
   *   /v4/.../ev/schedule/  – CPPLUS (was /v2/.../ev/schedule)
   *
   * @param {string} command
   */
  remoteCommand(command) {
    /** @type {Record<string, {apiVersion: string, segment: string, fallback?: {apiVersion: string, segment: string, command: string}}>} */
    const map = {
      VF: { apiVersion: 'v1', segment: 'location' },
      RDU: { apiVersion: 'v1', segment: 'remote' },
      RDL: { apiVersion: 'v1', segment: 'remote' },
      ROLIGHTS: { apiVersion: 'v1', segment: 'remote' },
      HBLF: { apiVersion: 'v1', segment: 'remote' },
      REON: { apiVersion: 'v1', segment: 'remote' },
      REOFF: { apiVersion: 'v1', segment: 'remote' },
      TA: { apiVersion: 'v1', segment: 'remote' },
      ROPRECOND: { apiVersion: 'v1', segment: 'remote' },
      ROPRECOND_OFF: { apiVersion: 'v1', segment: 'remote' },
      // promoted from v1 to v2 in the APK
      ROHVACON: { apiVersion: 'v2', segment: 'remote' },
      ROHVACOFF: { apiVersion: 'v2', segment: 'remote' },
      ROTRUNKLOCK: { apiVersion: 'v2', segment: 'remote' },
      ROTRUNKUNLOCK: { apiVersion: 'v2', segment: 'remote' },
      ROLIFTGATELOCK: { apiVersion: 'v2', segment: 'remote' },
      ROLIFTGATEUNLOCK: { apiVersion: 'v2', segment: 'remote' },
      ACV: { apiVersion: 'v2', segment: 'remote' },
      ROHVACTMP: { apiVersion: 'v2', segment: 'remote' },
      // EV commands keep v1 path but py-uconnect documents v2/v4 fallbacks
      DEEPREFRESH: {
        apiVersion: 'v1',
        segment: 'ev',
        fallback: { apiVersion: 'v2', segment: 'ev', command: 'DEEPREFRESH2' },
      },
      CNOW: {
        apiVersion: 'v1',
        segment: 'ev/chargenow',
        fallback: { apiVersion: 'v4', segment: 'ev/chargenow', command: 'START_CHARGE' },
      },
      // CPPLUS: /v2/.../ev/schedule/ with body { command, pinAuth, schedules[] }
      // as decoded from the APK model ScheduleV2Model$Post$Request. v3/v4
      // endpoints exist in the APK too but use a different body layout
      // (chargeSchedulesV3/V4 arrays); we start with v2 which the historical
      // adapter already used with the array-of-schedules state default.
      CPPLUS: { apiVersion: 'v2', segment: 'ev/schedule' },
    };
    return map[command];
  }

  async updateAllVehicles() {
    for (const vin of this.idArray) {
      await this.fetchVehicleStatus(vin);
      await this.fetchVehicle(
        vin,
        '/v1/accounts/' + this.UID + '/vehicles/' + vin + '/location/lastknown/',
        'location',
        'get vehicles location failed',
      );
      await this.fetchVehicle(
        vin,
        '/v1/accounts/' + this.UID + '/vehicles/' + vin + '/vhr/',
        'vhr',
        'get vehicles vhr failed',
      );
      await this.fetchVehicle(
        vin,
        '/v1/accounts/' + this.UID + '/vehicles/' + vin + '/svla/status/',
        'svla',
        'get vehicles svla failed',
      );
    }
  }

  /**
   * Vehicle status moved from /v2/.../status (old adapter path) to /v3 and /v4
   * in newer FCA backends — APK MyUrlFactory exposes both `URL_INFO` (v3) and
   * `URL_INFO_v4`. Try v3 first, fall back to v4 on 4xx (py-uconnect behaviour).
   *
   * @param {string} vin
   */
  async fetchVehicleStatus(vin) {
    for (const apiVersion of ['v3', 'v4']) {
      const url = '/' + apiVersion + '/accounts/' + this.UID + '/vehicles/' + vin + '/status/';
      try {
        return await this.getVehicleStatus(vin, url, 'status', undefined, { swallow404: false });
      } catch (error) {
        const err = /** @type {any} */ (error);
        const status = err && err.response && err.response.status;
        if (status === 400 || status === 404 || status === 502) {
          this.log.debug('status ' + apiVersion + ' returned ' + status + ', trying next');
          continue;
        }
        this.log.error('get vehicles status failed');
        return;
      }
    }
    this.log.warn('Vehicle ' + vin + ' has no working /v3 or /v4 status endpoint');
  }

  /**
   * @param {string} vin
   * @param {string} url
   * @param {string} path
   * @param {string} errorMessage
   */
  async fetchVehicle(vin, url, path, errorMessage) {
    try {
      return await this.getVehicleStatus(vin, url, path);
    } catch {
      this.log.error(errorMessage);
    }
  }

  /**
   * Helper: snapshot the current cookie jar for the given URL.
   *
   * @param {string} url
   * @returns {string}
   */
  cookieSnapshot(url) {
    try {
      const cookies = this.cookieJar.getCookiesSync(url);
      return cookies.length
        ? cookies.map((c) => c.key + '=' + (c.value || '').slice(0, 12) + '…').join('; ')
        : '(empty)';
    } catch (error) {
      return '(read error: ' + String(error) + ')';
    }
  }

  /**
   * Helper: log the relevant fields from a Gigya REST envelope without dumping
   * the entire body (which can contain tokens we don't want in info logs).
   *
   * @param {string} step
   * @param {any} body
   */
  logGigya(step, body) {
    if (!body || typeof body !== 'object') {
      this.log.info(step + ': empty body');
      return;
    }
    const summary = {
      statusCode: body.statusCode,
      errorCode: body.errorCode,
      errorMessage: body.errorMessage,
      errorDetails: body.errorDetails,
      errorFlags: body.errorFlags,
      callId: body.callId,
    };
    this.log.info(step + ': ' + JSON.stringify(summary));
  }

  /**
   * Extract the `name=value` pair from each Set-Cookie header and join them
   * into a single Cookie-header string. Some Node 22 / http-cookie-agent
   * combinations silently fail to persist the GMID into the tough-cookie jar
   * (observed on production ioBroker hosts: bootstrap returns 3 Set-Cookie
   * headers, jar reads back as empty). Gigya then rejects accounts.login with
   * `errorCode 400006 / errorFlags missingKey`. Replaying the cookies via an
   * explicit Cookie header avoids that whole class of jar/agent bugs.
   *
   * @param {string[] | string | undefined} setCookieHeaders
   * @returns {string}
   */
  /**
   * Compact, value-free preview of a Cookie header string. We log cookie
   * NAMES only — values would leak the session.
   *
   * @param {string} cookieHeader
   * @returns {string}
   */
  cookieNames(cookieHeader) {
    if (!cookieHeader) {
      return '(none)';
    }
    return cookieHeader
      .split(';')
      .map((c) => c.trim().split('=')[0])
      .filter(Boolean)
      .join(',');
  }

  /**
   * Extract the `name=value` pair from each Set-Cookie header and join them
   * into a single Cookie-header string. Some Node 22 / http-cookie-agent
   * combinations silently fail to persist the GMID into the tough-cookie jar
   * (observed on production ioBroker hosts: bootstrap returns 3 Set-Cookie
   * headers, jar reads back as empty). Gigya then rejects accounts.login with
   * `errorCode 400006 / errorFlags missingKey`. Replaying the cookies via an
   * explicit Cookie header avoids that whole class of jar/agent bugs.
   *
   * @param {string[] | string | undefined} setCookieHeaders
   * @returns {string}
   */
  cookieHeaderFromSetCookie(setCookieHeaders) {
    if (!setCookieHeaders) {
      return '';
    }
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    return headers
      .map((h) => String(h).split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
  }

  async login() {
    this.log.info(
      'login() type=' +
        this.type +
        ' brand=' +
        this.brandCode +
        ' loginUrl=https://' +
        this.loginUrl +
        ' myuUrl=https://' +
        this.myuUrl +
        ' loginApiKey=' +
        (this.loginApiKey || '').slice(0, 8) +
        '… apiKey=' +
        (this.apiKey || '').slice(0, 8) +
        '…',
    );

    try {
      this.log.info('Step 1/5: Gigya bootstrap');
      const bootstrap = await this.requestClient({
        method: 'get',
        url:
          'https://' +
          this.loginUrl +
          '/accounts.webSdkBootstrap?apiKey=' +
          this.loginApiKey +
          '&pageURL=https%3A%2F%2F' +
          this.myuUrl +
          '%2Fde%2Fde%2Fvehicle-services&sdk=js_latest&sdkBuild=12234&format=json',
        headers: {
          accept: '*/*',
          origin: 'https://' + this.myuUrl + '',
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
          'accept-language': 'de-de',
          referer: 'https://' + this.myuUrl + '/de/de/vehicle-services',
        },
      });

      if (!bootstrap.data) {
        this.log.error('first page failed');
        throw new Error('first page failed');
      }
      const setCookieHeader = bootstrap.headers && bootstrap.headers['set-cookie'];
      this.log.info(
        'Step 1/5: bootstrap http=' +
          bootstrap.status +
          ' set-cookie-count=' +
          (Array.isArray(setCookieHeader) ? setCookieHeader.length : setCookieHeader ? 1 : 0),
      );
      if (setCookieHeader) {
        this.log.debug('Set-Cookie: ' + JSON.stringify(setCookieHeader));
      }
      // Some Node 22 / http-cookie-agent combinations on Linux fail to persist
      // the GMID into the tough-cookie jar (observed: bootstrap returns 3
      // Set-Cookie headers, jar reads back as empty). Replaying the cookies
      // via an explicit Cookie header on the following calls sidesteps the
      // jar entirely.
      const gigyaCookieHeader = this.cookieHeaderFromSetCookie(setCookieHeader);
      this.log.info(
        'Cookies after bootstrap: jar=' +
          this.cookieSnapshot('https://' + this.loginUrl + '/') +
          ' explicit=' +
          (gigyaCookieHeader
            ? gigyaCookieHeader
              .split('; ')
              .map((c) => c.split('=')[0])
              .join(',')
            : '(none)'),
      );
      this.logGigya('Step 1/5: bootstrap body', bootstrap.data);

      this.log.info('Step 2/5: Gigya accounts.login');
      // Use URLSearchParams so each field is URL-encoded uniformly. The old
      // `loginID=' + this.config.user` concatenation skipped encoding on the
      // email address — values containing `+`, `&`, `=` would corrupt the
      // form and Gigya answers `errorCode 400006, errorFlags missingKey`.
      const loginForm = new URLSearchParams({
        loginID: this.config.user,
        password: this.config.password,
        sessionExpiration: '7776000',
        targetEnv: 'jssdk',
        include: 'profile,data,emails,subscriptions,preferences,',
        includeUserInfo: 'true',
        loginMode: 'standard',
        lang: 'de0de',
        riskContext: JSON.stringify({ b0: 52569, b2: 8, b5: 1 }),
        APIKey: this.loginApiKey || '',
        source: 'showScreenSet',
        sdk: 'js_latest',
        authMode: 'cookie',
        pageURL: 'https://' + this.myuUrl + '/de/de/login',
        sdkBuild: '12234',
        format: 'json',
      });
      const loginResponse = await this.requestClient({
        method: 'post',
        url: 'https://' + this.loginUrl + '/accounts.login',
        headers: {
          accept: '*/*',
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://' + this.myuUrl + '',
          'accept-language': 'de-de',
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
          referer: 'https://' + this.myuUrl + '/de/de/login',
          ...(gigyaCookieHeader ? { cookie: gigyaCookieHeader } : {}),
        },
        data: loginForm.toString(),
      });

      this.log.info(
        'Step 2/5: accounts.login sent cookies=' + this.cookieNames(gigyaCookieHeader),
      );

      this.logGigya('Step 2/5: accounts.login', loginResponse.data);

      if (!loginResponse.data) {
        this.log.error('Login failed maybe incorrect login information');
        throw new Error('Login failed maybe incorrect login information');
      }
      this.log.debug(JSON.stringify(loginResponse.data));
      if (!loginResponse.data.sessionInfo) {
        if (loginResponse.data.errorCode === 400006) {
          this.log.error(
            'Gigya blocked the login (errorCode 400006, "' +
              loginResponse.data.errorDetails +
              '"). This usually means the GMID cookie from the bootstrap was not sent back. ' +
              'Cookies for the login host: ' +
              this.cookieSnapshot('https://' + this.loginUrl + '/'),
          );
        }
        this.log.error('sessionInfo missing');
        throw new Error('sessionInfo missing');
      }
      this.loginToken = loginResponse.data.sessionInfo.login_token;
      this.UID = loginResponse.data.userInfo.UID;
      this.log.info('Step 2/5: accounts.login OK UID=' + this.UID);
      this.json2iob.parse('general', loginResponse.data);

      // Merge any additional cookies set by accounts.login (e.g. glt_*) into
      // the explicit cookie header so getJWT sees the full session.
      const loginSetCookie = loginResponse.headers && loginResponse.headers['set-cookie'];
      const loginCookieHeader = this.cookieHeaderFromSetCookie(loginSetCookie);
      const sessionCookieHeader = [gigyaCookieHeader, loginCookieHeader].filter(Boolean).join('; ');
      this.log.info(
        'Step 2/5: accounts.login set-cookie-count=' +
          (Array.isArray(loginSetCookie) ? loginSetCookie.length : loginSetCookie ? 1 : 0) +
          ' new=' +
          this.cookieNames(loginCookieHeader),
      );
      if (loginSetCookie) {
        this.log.debug('accounts.login Set-Cookie: ' + JSON.stringify(loginSetCookie));
      }

      this.log.info(
        'Step 3/5: Gigya getJWT (GET) cookies=' + this.cookieNames(sessionCookieHeader),
      );
      const jwtResponse = await this.requestClient({
        method: 'get',
        url:
          'https://' +
          this.loginUrl +
          '/accounts.getJWT?fields=profile.firstName%2Cprofile.lastName%2Cprofile.email%2Ccountry%2Clocale%2Cdata.disclaimerCodeGSDP%2Cdata.GSDPisVerified&APIKey=' +
          this.loginApiKey +
          '&sdk=js_latest&login_token=' +
          this.loginToken +
          '&authMode=cookie&pageURL=https%3A%2F%2F' +
          this.myuUrl +
          '%2Fde%2Fde%2Fdashboard&sdkBuild=12234&format=json',
        headers: {
          accept: '*/*',
          origin: 'https://' + this.myuUrl + '',
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
          'accept-language': 'de-de',
          referer: 'https://' + this.myuUrl + '/de/de/dashboard',
          ...(sessionCookieHeader ? { cookie: sessionCookieHeader } : {}),
        },
      });

      this.logGigya('Step 3/5: getJWT', jwtResponse.data);
      if (!jwtResponse.data) {
        this.log.error('JWT failed maybe incorrect login information');
        throw new Error('JWT failed');
      }
      this.log.debug(JSON.stringify(jwtResponse.data));
      if (!jwtResponse.data.id_token) {
        this.log.error('id_token missing');
        throw new Error('id_token missing');
      }
      this.idToken = jwtResponse.data.id_token;
      this.log.info('Step 3/5: getJWT OK id_token len=' + this.idToken.length);

      this.log.info('Step 4/5: FCA exchange Gigya JWT → Cognito identity token');
      const fcaResponse = await this.requestClient({
        method: 'post',
        url: 'https://authz.sdpr-01.fcagcv.com/v2/cognito/identity/token',
        headers: {
          'content-type': 'application/json',
          'x-clientapp-version': '1.0',
          clientrequestid: this.randomString(16),
          accept: '*/*',
          locale: 'de_de',
          'x-api-key': this.apiKey,
          'accept-language': 'de-de',
          origin: 'https://' + this.myuUrl + '',
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
          referer: 'https://' + this.myuUrl + '/de/de/dashboard',
          'x-originator-type': 'web',
        },
        data: JSON.stringify({
          gigya_token: this.idToken,
        }),
      });

      if (!fcaResponse.data) {
        this.log.error('fca failed maybe incorrect login information');
        throw new Error('fca failed');
      }
      this.log.debug(JSON.stringify(fcaResponse.data));
      if (!fcaResponse.data.Token) {
        this.log.error('Token missing');
        throw new Error('Token missing');
      }
      this.token = fcaResponse.data.Token;
      this.identityId = fcaResponse.data.IdentityId;
      this.log.info('Step 4/5: Cognito token OK IdentityId=' + this.identityId);

      this.log.info('Step 5/5: AWS GetCredentialsForIdentity');
      const data = JSON.stringify({
        IdentityId: this.identityId,
        Logins: {
          'cognito-identity.amazonaws.com': this.token,
        },
      });

      const amzResponse = await this.requestClient({
        method: 'post',
        url: 'https://cognito-identity.eu-west-1.amazonaws.com/',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          accept: '*/*',
          'x-amz-user-agent': 'aws-sdk-js/2.283.1 callback',
          'accept-language': 'de-de',
          origin: 'https://' + this.myuUrl + '',
          'x-amz-content-sha256': crypto.createHash('sha256').update(data).digest('hex'),
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
          referer: 'https://' + this.myuUrl + '/de/de/dashboard',
          'x-amz-target': 'AWSCognitoIdentityService.GetCredentialsForIdentity',
        },
        data: data,
      });

      if (!amzResponse.data) {
        this.log.error('amz failed maybe incorrect login information');
        throw new Error('amz failed');
      }
      this.log.debug(JSON.stringify(amzResponse.data));
      this.amz = amzResponse.data;
      if (!this.amz.Credentials) {
        this.log.error('Credentials missing');
        throw new Error('Credentials missing');
      }
      this.log.info(
        'Step 5/5: AWS creds OK expires=' +
          (this.amz.Credentials.Expiration || 'unknown') +
          ' key=' +
          (this.amz.Credentials.AccessKeyId || '').slice(0, 8) +
          '…',
      );
    } catch (error) {
      const err = /** @type {any} */ (error);
      this.log.error(String(err));
      if (err && err.response) {
        this.log.error(
          'http=' +
            err.response.status +
            ' body=' +
            JSON.stringify(err.response.data).slice(0, 800),
        );
      }
      throw err;
    }
  }

  async getVehicles() {
    const headers = {
      Host: 'channels.sdpr-01.fcagcv.com',
      'content-type': 'application/json',
      'x-clientapp-version': '1.0',
      clientrequestid: this.randomString(16),
      accept: 'application/json, text/plain, */*',
      'x-amz-date': this.amzDate(),
      'x-amz-security-token': this.amz.Credentials.SessionToken,
      locale: 'de_de',
      'x-api-key': this.apiKey,
      'accept-language': 'de-de',
      'x-clientapp-name': 'CWP',
      origin: 'https://' + this.myuUrl + '',
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
      referer: 'https://' + this.myuUrl + '/de/de/dashboard',
      'x-originator-type': 'web',
    };
    // APK MyUrlFactory.smali: /v4/accounts/%s/vehicles/?sdp=ALL&stage=ALL&brand=FIAT
    // brandCode is FIAT for FIAT / Alfa-EU, REST for Jeep-EU (py-uconnect).
    const vehiclesPath =
      '/v4/accounts/' +
      this.UID +
      '/vehicles/?sdp=ALL&stage=ALL&brand=' +
      this.brandCode;
    const signed = aws4.sign(
      {
        host: 'channels.sdpr-01.fcagcv.com',
        path: vehiclesPath,
        service: 'execute-api',
        method: 'GET',
        region: 'eu-west-1',
        headers: headers,
      },
      { accessKeyId: this.amz.Credentials.AccessKeyId, secretAccessKey: this.amz.Credentials.SecretKey },
    );
    this.log.debug(signed);
    headers['Authorization'] = signed.headers['Authorization'];

    let response;
    try {
      response = await this.requestClient({
        method: 'get',
        url: 'https://channels.sdpr-01.fcagcv.com' + vehiclesPath,
        headers: headers,
      });
    } catch (error) {
      const err = /** @type {any} */ (error);
      this.log.error(String(err));
      this.log.error('GetVehicles failed');
      if (err && err.response) {
        this.log.error(JSON.stringify(err.response.data));
      }
      throw err;
    }

    if (!response.data) {
      this.log.error('Get vehicles failed');
      throw new Error('Get vehicles failed');
    }
    this.log.debug(JSON.stringify(response.data));

    for (const element of response.data.vehicles) {
      this.idArray.push(element.vin);
      await this.setObjectNotExistsAsync(element.vin, {
        type: 'device',
        common: {
          name: element.modelDescription,
          role: 'indicator',
        },
        native: {},
      });
      await this.setObjectNotExistsAsync(element.vin + '.remote', {
        type: 'channel',
        common: {
          name: 'Remote Controls',
          role: 'indicator',
        },
        native: {},
      });
      const remoteArray = [
        { command: 'VF', name: 'Update Location' },
        { command: 'RDU', name: 'Unlock' },
        { command: 'RDL', name: 'Lock' },
        { command: 'ROLIGHTS', name: 'Lights' },
        { command: 'ROHVACON', name: 'AC On' },
        { command: 'ROHVACOFF', name: 'AC Off' },
        { command: 'ROTRUNKLOCK', name: 'Trunk Lock' },
        { command: 'ROTRUNKUNLOCK', name: 'Trunk Unlock' },
        { command: 'ROLIFTGATELOCK', name: 'Liftgate Lock' },
        { command: 'ROLIFTGATEUNLOCK', name: 'Liftgate Unlock' },
        { command: 'ACV', name: 'Cabin Ventilation' },
        { command: 'REON', name: 'Engine on' },
        { command: 'REOFF', name: 'Engine off' },
        { command: 'HBLF', name: 'Locate Horn Lights' },
        { command: 'TA', name: 'Theft Alarm Suppress' },
        { command: 'CNOW', name: 'Charge Now' },
        { command: 'DEEPREFRESH', name: 'Deep refresh charging state' },
        { command: 'ROPRECOND', name: 'Precondition/Klima' },
        { command: 'ROPRECOND_OFF', name: 'Precondition/Klima Off' },
        {
          command: 'CPPLUS',
          name: 'Change Schedule',
          role: 'json',
          type: 'string',
          def: `[
    {
        "cabinPriority": false,
        "chargeToFull": false,
        "enableScheduleType": true,
        "endTime": "13:05",
        "repeatSchedule": true,
        "scheduleType": "CHARGE",
        "scheduledDays": {
            "friday": true,
            "monday": true,
            "saturday": true,
            "sunday": true,
            "thursday": true,
            "tuesday": true,
            "wednesday": true
        },
        "startTime": "13:00"
    },
    {
        "cabinPriority": true,
        "chargeToFull": false,
        "enableScheduleType": false,
        "endTime": "11:45",
        "repeatSchedule": false,
        "scheduleType": "CLIMATE",
        "scheduledDays": {
            "friday": false,
            "monday": false,
            "saturday": false,
            "sunday": false,
            "thursday": false,
            "tuesday": false,
            "wednesday": false
        },
        "startTime": "11:45"
    },
    {
        "cabinPriority": false,
        "chargeToFull": false,
        "enableScheduleType": false,
        "endTime": "00:00",
        "repeatSchedule": true,
        "scheduleType": "CHARGE",
        "scheduledDays": {
            "friday": false,
            "monday": false,
            "saturday": false,
            "sunday": false,
            "thursday": false,
            "tuesday": false,
            "wednesday": false
        },
        "startTime": "00:00"
    }
]`,
        },
      ];
      for (const remote of remoteArray) {
        await this.setObjectNotExistsAsync(element.vin + '.remote.' + remote.command, {
          type: 'state',
          common: {
            name: remote.name,
            type: /** @type {ioBroker.CommonType} */ (remote.type || 'boolean'),
            role: remote.role || 'button',
            def: remote.def != null ? remote.def : false,
            write: true,
            read: true,
          },
          native: {},
        });
      }

      this.json2iob.parse(element.vin + '.general', element, { preferedArrayName: 'service' });
    }
  }

  /**
   * @param {string} vin
   * @param {string} url
   * @param {string | null} [path]
   * @param {string} [data]
   * @param {{swallow404?: boolean}} [options]
   */
  async getVehicleStatus(vin, url, path, data, options) {
    const swallow404 = !options || options.swallow404 !== false;
    let method = 'GET';
    if (data) {
      method = 'POST';
    }
    const headers = {
      Host: 'channels.sdpr-01.fcagcv.com',
      'content-type': 'application/json',
      'x-clientapp-version': '1.0',
      clientrequestid: this.randomString(16),
      accept: 'application/json, text/plain, */*',
      'x-amz-date': this.amzDate(),
      'x-amz-security-token': this.amz.Credentials.SessionToken,
      locale: 'de_de',
      'x-api-key': this.apiKey,
      'accept-language': 'de-de',
      'x-clientapp-name': 'CWP',
      origin: 'https://' + this.myuUrl + '',
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1',
      referer: 'https://' + this.myuUrl + '/de/de/dashboard',
      'x-originator-type': 'web',
    };
    const signed = aws4.sign(
      {
        host: 'channels.sdpr-01.fcagcv.com',
        body: data,
        path: url,
        service: 'execute-api',
        method: method,
        region: 'eu-west-1',
        headers: headers,
      },
      { accessKeyId: this.amz.Credentials.AccessKeyId, secretAccessKey: this.amz.Credentials.SecretKey },
    );
    headers['Authorization'] = signed.headers['Authorization'];

    try {
      const response = await this.requestClient({
        method: method,
        url: 'https://channels.sdpr-01.fcagcv.com' + url,
        headers: headers,
        data: data,
      });

      if (!response.data) {
        this.log.error('Get vehicles failed: ' + path);
        throw new Error('Empty response');
      }
      this.log.debug(JSON.stringify(response.data));
      if (path) {
        this.json2iob.parse(vin + '.' + path, response.data, { preferedArrayName: 'itemKey' });
      }
      return response.data;
    } catch (error) {
      const err = /** @type {any} */ (error);
      if (err && err.response && err.response.status === 404) {
        this.log.debug('Get vehicles failed: ' + path);
        this.log.debug(JSON.stringify(err.response.data));
        if (!swallow404) {
          throw err;
        }
        return {};
      }
      if (err && err.response && err.response.status === 403) {
        this.log.debug(JSON.stringify(err.response.data));
        this.log.info(path + ' receive 403 error. Relogin in 30 seconds');
        clearTimeout(this.reLoginTimeout);
        this.reLoginTimeout = setTimeout(async () => {
          try {
            await this.login();
          } catch {
            this.log.error('Relogin failed restart adapter');
            this.reLoginTimeout = setTimeout(() => {
              this.restart();
            }, 1000 * 60 * 5);
          }
        }, 1000 * 30);
        throw err;
      }
      this.log.error(String(err));
      this.log.error('Request failed: ' + path);
      if (err && err.response) {
        this.log.error(
          'Response status=' +
            err.response.status +
            ' statusText=' +
            err.response.statusText +
            ' headers=' +
            JSON.stringify(err.response.headers || {}) +
            ' data=' +
            JSON.stringify(err.response.data),
        );
      }
      throw err;
    }
  }

  /**
   * @param {number} length
   */
  randomString(length) {
    let result = '';
    const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }

  amzDate() {
    return new Date().toISOString().slice(0, 20).replace(/-/g, '').replace(/:/g, '').replace(/\./g, '') + 'Z';
  }
  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    try {
      if (!state || state.ack) {
        return;
      }
      if (!id.includes('.remote.')) {
        return;
      }
      const vin = id.split('.')[2];
      const command = id.split('.')[4];
      const meta = this.remoteCommand(command);
      this.log.info(
        'onStateChange: id=' +
          id +
          ' vin=' +
          vin +
          ' command=' +
          command +
          ' val=' +
          (typeof state.val === 'object' ? JSON.stringify(state.val).slice(0, 200) : String(state.val)) +
          ' meta=' +
          (meta ? meta.apiVersion + '/' + meta.segment : 'UNKNOWN'),
      );
      if (!meta) {
        this.log.warn('Unsupported remote command: ' + command);
        return;
      }

      let pinAuth;
      try {
        pinAuth = await this.receivePinAuth();
      } catch (error) {
        this.log.error('Failed to authenticate pin for command ' + command);
        if (error) {
          this.log.error(String(error));
        }
        return;
      }
      this.log.info(
        'pinAuth [after receivePinAuth in onStateChange] typeof=' +
          typeof pinAuth +
          ' len=' +
          (pinAuth ? String(pinAuth).length : 0) +
          ' head=' +
          String(pinAuth || '').slice(0, 20),
      );

      try {
        await this.sendRemoteCommand(vin, command, meta, state.val, pinAuth);

        this.updateTimeout = setTimeout(async () => {
          await this.fetchVehicle(
            vin,
            '/v1/accounts/' + this.UID + '/vehicles/' + vin + '/location/lastknown/',
            'location',
            'get vehicles location failed',
          );
          await this.fetchVehicleStatus(vin);
        }, 10 * 1000);
      } catch (error) {
        const err = /** @type {any} */ (error);
        const status = err && err.response && err.response.status;
        this.log.error('Failed to set remote command ' + command + ' (http=' + status + ')');
      }
    } catch (err) {
      this.log.error('Error in OnStateChange: ' + err);
    }
  }

  /**
   * Send a remote command. CPPLUS sends a schedule payload (the parsed JSON
   * merged with `pinAuth`, no top-level `command` — py-uconnect:set_charge_schedule);
   * everything else is { command, pinAuth }. On a 403 the command's documented
   * fallback (e.g. CNOW → START_CHARGE on /v4) is tried once. 404 is passed
   * through (not swallowed) so the fallback can fire.
   *
   * @param {string} vin
   * @param {string} command
   * @param {{apiVersion: string, segment: string, fallback?: {apiVersion: string, segment: string, command: string}}} meta
   * @param {ioBroker.StateValue} value
   * @param {string} pinAuth
   */
  async sendRemoteCommand(vin, command, meta, value, pinAuth) {
    const url =
      '/' + meta.apiVersion + '/accounts/' + this.UID + '/vehicles/' + vin + '/' + meta.segment + '/';
    this.log.info(
      'sendRemoteCommand [entry] cmd=' +
        command +
        ' pinAuth typeof=' +
        typeof pinAuth +
        ' len=' +
        (pinAuth ? String(pinAuth).length : 0) +
        ' head=' +
        String(pinAuth || '').slice(0, 20),
    );

    /** @param {Record<string, any>} data */
    const post = async (data) => {
      this.log.info(
        'post [entry] cmd=' +
          command +
          ' data.pinAuth typeof=' +
          typeof data.pinAuth +
          ' len=' +
          (data.pinAuth ? String(data.pinAuth).length : 0) +
          ' head=' +
          String(data.pinAuth || '').slice(0, 20),
      );
      this.log.info(
        'Remote: cmd=' +
          command +
          ' method=POST url=https://channels.sdpr-01.fcagcv.com' +
          url +
          ' pinAuth=' +
          String(data.pinAuth || '').slice(0, 20),
      );
      try {
        const result = await this.getVehicleStatus(vin, url, null, JSON.stringify(data), {
          swallow404: false,
        });
        if (result && result.responseStatus !== 'pending') {
          this.log.warn(JSON.stringify(result));
        }
        return result;
      } catch (error) {
        const err = /** @type {any} */ (error);
        const status = err && err.response && err.response.status;
        if (meta.fallback && (status === 403 || status === 404)) {
          this.log.warn(
            command +
              ' returned ' +
              status +
              ', retrying with ' +
              meta.fallback.command +
              ' (' +
              meta.fallback.apiVersion +
              ')',
          );
          const fbUrl =
            '/' +
            meta.fallback.apiVersion +
            '/accounts/' +
            this.UID +
            '/vehicles/' +
            vin +
            '/' +
            meta.fallback.segment +
            '/';
          const fbData = { ...data, command: meta.fallback.command };
          this.log.info('Remote fallback: url=https://channels.sdpr-01.fcagcv.com' + fbUrl);
          return await this.getVehicleStatus(vin, fbUrl, null, JSON.stringify(fbData), {
            swallow404: false,
          });
        }
        throw err;
      }
    };

    if (command === 'CPPLUS') {
      if (value === null || value === undefined) {
        this.log.error('CPPLUS: schedule state is empty');
        return;
      }
      let parsed;
      if (typeof value === 'object') {
        parsed = value;
      } else {
        try {
          parsed = JSON.parse(String(value));
        } catch (error) {
          this.log.error('Failed to parse schedule');
          this.log.error(String(error));
          return;
        }
      }
      // Accept both shapes: a single schedule object or an array of schedules.
      const userSchedules = Array.isArray(parsed) ? parsed : [parsed];

      // The vehicle has a FIXED number of schedule slots (3 on the 500e). The
      // official app (APK ScheduleV2ViewModel.saveSchedules) always POSTs the
      // COMPLETE slot array back, never a partial one — a partial array is
      // accepted with responseStatus:pending but silently discarded by the
      // car. So we GET the current slots, overwrite the leading ones with the
      // user's schedules, and keep the remaining slots untouched. Slot order
      // in the array is the slot identity.
      let slots = userSchedules;
      try {
        const current = await this.getVehicleStatus(vin, url, null, undefined, { swallow404: false });
        const currentSchedules =
          current && Array.isArray(current.schedules) ? current.schedules : [];
        this.log.info(
          'CPPLUS: server has ' +
            currentSchedules.length +
            ' slots, user provided ' +
            userSchedules.length,
        );
        if (currentSchedules.length > 0) {
          // Start from the server's slots (preserves count + empty-slot shape),
          // overwrite from the front with the user's schedules.
          slots = currentSchedules.map((slot, i) => (i < userSchedules.length ? userSchedules[i] : slot));
          // If the user supplied MORE schedules than the vehicle has slots,
          // append the extras (best effort).
          if (userSchedules.length > currentSchedules.length) {
            slots = slots.concat(userSchedules.slice(currentSchedules.length));
          }
        }
      } catch (error) {
        const err = /** @type {any} */ (error);
        this.log.warn(
          'CPPLUS: could not GET current slots (' +
            (err && err.response && err.response.status) +
            '), sending user schedules as-is',
        );
      }

      // Body shape from APK ScheduleV2Model$Post$Request: {command, pinAuth, schedules[]}
      return await post({ command: 'CPPLUS', pinAuth: pinAuth, schedules: slots });
    }

    return await post({ command, pinAuth: pinAuth });
  }

  /**
   * Fetches a fresh pin-auth token from the FCA MFA endpoint and returns it.
   * Historically the token was stashed on `this.pinAuth` — but that made
   * concurrent onStateChange handlers race against a shared field. The
   * caller now owns the value and passes it to sendRemoteCommand explicitly.
   *
   * @returns {Promise<string>}
   */
  async receivePinAuth() {
    if (!this.config.pin) {
      this.log.warn('No pin in instance settings');
      throw new Error('No pin in instance settings');
    }

    const data = JSON.stringify({ pin: Buffer.from(this.config.pin).toString('base64') });
    const url = '/v1/accounts/' + this.UID + '/ignite/pin/authenticate';
    const method = 'POST';
    const headers = {
      Host: 'mfa.fcl-01.fcagcv.com',
      'sec-ch-ua': '"Chromium";v="91", " Not A;Brand";v="99", "Google Chrome";v="91"',
      clientrequestid: this.randomString(16),
      'content-type': 'application/json',
      requestid: this.randomString(16),
      accept: 'application/json, text/plain, */*',
      'x-amz-date': this.amzDate(),
      'x-amz-security-token': this.amz.Credentials.SessionToken,
      locale: 'de_de',
      'x-api-key': 'JWRYW7IYhW9v0RqDghQSx4UcRYRILNmc8zAuh5ys',
      'accept-language': 'de-de',
      origin: 'https://' + this.myuUrl + '',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      referer: 'https://' + this.myuUrl + '/',
      'x-originator-type': 'web',
      'sec-ch-ua-mobile': '?0',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.164 Safari/537.36',
    };
    const signed = aws4.sign(
      {
        host: 'mfa.fcl-01.fcagcv.com',
        body: data,
        path: url,
        service: 'execute-api',
        method: method,
        region: 'eu-west-1',
        headers: headers,
      },
      { accessKeyId: this.amz.Credentials.AccessKeyId, secretAccessKey: this.amz.Credentials.SecretKey },
    );
    headers['Authorization'] = signed.headers['Authorization'];

    try {
      const response = await this.requestClient({
        method: method,
        url: 'https://mfa.fcl-01.fcagcv.com' + url,
        headers: headers,
        data: data,
      });

      if (!response.data) {
        this.log.error('Get pin failed: ');
        throw new Error('Get pin failed');
      }
      this.log.debug(JSON.stringify(response.data));
      // Validate the token strictly: MFA has been observed to return
      // { token: "" } with expiry set, and the CPPLUS POST would then be
      // rejected as "Wrong or missing request body". py-uconnect treats a
      // missing token as a hard failure (api.py _pin_auth); do the same.
      const token = response.data.token;
      if (typeof token !== 'string' || token.length === 0) {
        this.log.error(
          'pinAuth: MFA response did not contain a usable token ' +
            '(typeof=' +
            typeof token +
            ' len=' +
            (token ? String(token).length : 0) +
            ')',
        );
        throw new Error('pinAuth missing/empty');
      }
      this.log.info(
        'pinAuth: obtained token typeof=' +
          typeof token +
          ' len=' +
          token.length +
          ' expiry=' +
          response.data.expiry,
      );
      return token;
    } catch (error) {
      const err = /** @type {any} */ (error);
      if (err && err.response && err.response.status === 403) {
        if (err.response.data && err.response.data.name === 'INVALID_PIN') {
          this.log.error(JSON.stringify(err.response.data));
          throw err;
        }
        this.log.debug(JSON.stringify(err.response.data));
        this.log.info('pin auth receive 403 error. Relogin in 30 seconds');
        clearTimeout(this.reLoginTimeout);
        this.reLoginTimeout = setTimeout(async () => {
          try {
            await this.login();
          } catch {
            this.log.error('Relogin failed restart adapter');
            this.reLoginTimeout = setTimeout(() => {
              this.restart();
            }, 1000 * 60 * 5);
          }
        }, 1000 * 30);
        throw err;
      }
      this.log.error(String(err));
      this.log.error('get pin failed');
      if (err && err.response) {
        this.log.error(JSON.stringify(err.response.data));
      }
      throw err;
    }
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      callback();
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      this.appUpdateInterval && clearInterval(this.appUpdateInterval);
      clearTimeout(this.reLoginTimeout);
    } catch {
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
