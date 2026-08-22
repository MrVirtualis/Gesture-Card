(function () {
  function parseColor(colorStr) {
    if (!colorStr) return '';
    if (
      colorStr.startsWith('#') ||
      colorStr.startsWith('rgb') ||
      colorStr.startsWith('hsl') ||
      colorStr.startsWith('var(')
    ) {
      return colorStr;
    }
    return `var(--${colorStr}-color, var(--${colorStr}, ${colorStr}))`;
  }

  function kelvinToRgb(kelvin) {
    const temp = kelvin / 100;
    let r, g, b;
    if (temp <= 66) {
      r = 255;
      g = Math.min(255, Math.max(0, 99.4708025861 * Math.log(temp) - 161.1195681661));
    } else {
      r = Math.min(255, Math.max(0, 329.698727446 * Math.pow(temp - 60, -0.1332047592)));
      g = Math.min(255, Math.max(0, 288.1221695283 * Math.pow(temp - 60, -0.0755148492)));
    }
    if (temp >= 66) {
      b = 255;
    } else if (temp <= 19) {
      b = 0;
    } else {
      b = Math.min(255, Math.max(0, 138.5177312231 * Math.log(temp - 10) - 305.0447927307));
    }
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  }

  function getRawStateColor(stateObj) {
    if (!stateObj) return 'var(--state-icon-active-color, #ff9800)';
    if (stateObj.attributes) {
      if (Array.isArray(stateObj.attributes.rgb_color)) {
        return `rgb(${stateObj.attributes.rgb_color.join(',')})`;
      }
      if (stateObj.attributes.color_temp_kelvin) {
        return kelvinToRgb(stateObj.attributes.color_temp_kelvin);
      }
      if (stateObj.attributes.color_temp) {
        const kelvin = Math.round(1000000 / stateObj.attributes.color_temp);
        return kelvinToRgb(kelvin);
      }
    }
    return 'var(--state-icon-active-color, #ff9800)';
  }

  function formatValue(val, step) {
    if (step === undefined || step === null) step = 1;
    const stepStr = step.toString();
    const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
    return Number(val.toFixed(decimals));
  }

  function sendServiceCall(hass, entityId, attribute, value) {
    if (!hass || !entityId) return;
    const domain = entityId.split('.')[0];
    let serviceDomain = domain;
    let serviceName = 'turn_on';
    let payload = { entity_id: entityId };

    if (domain === 'light') {
      serviceDomain = 'light';
      serviceName = 'turn_on';
      if (attribute === 'brightness_pct') {
        payload.brightness_pct = value;
      } else if (attribute === 'brightness') {
        payload.brightness = value;
      } else if (attribute === 'color_temp_kelvin') {
        payload.color_temp_kelvin = value;
      } else if (attribute === 'color_temp') {
        payload.color_temp = value;
      } else if (attribute) {
        payload[attribute] = value;
      }
    } else if (domain === 'cover') {
      serviceDomain = 'cover';
      serviceName = 'set_cover_position';
      payload.position = value;
    } else if (domain === 'fan') {
      serviceDomain = 'fan';
      serviceName = 'set_percentage';
      payload.percentage = value;
    } else if (domain === 'media_player') {
      serviceDomain = 'media_player';
      serviceName = 'volume_set';
      payload.volume_level = value;
    } else if (domain === 'climate') {
      serviceDomain = 'climate';
      serviceName = 'set_temperature';
      payload.temperature = value;
    } else if (domain === 'number') {
      serviceDomain = 'number';
      serviceName = 'set_value';
      payload.value = value;
    } else if (domain === 'input_number') {
      serviceDomain = 'input_number';
      serviceName = 'set_value';
      payload.value = value;
    } else {
      serviceDomain = domain;
      serviceName = 'turn_on';
      if (attribute) {
        payload[attribute] = value;
      }
    }

    hass.callService(serviceDomain, serviceName, payload);
  }

  class GestureCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._config = null;
      this._hass = null;
      this._dragging = false;
      this._activeAxis = null;
      this._currentValue = 0;
      this._currentAttr = '';
      this._pointerId = null;
      this._startX = 0;
      this._startY = 0;
      this._startVVal = 0;
      this._startHVal = 0;
      this._holdTimer = null;
      this._isHold = false;
      this._lastCallTime = 0;
    }

    setConfig(config) {
      if (!config) throw new Error('Invalid configuration');
      this._config = {
        entity: '',
        show_icon: true,
        show_name: true,
        show_background: true,
        icon_size: 40,
        text_size: 14,
        use_state_color_icon: true,
        icon_color: '#ff9800',
        use_state_color_name: false,
        name_color: '',
        use_state_color_bg: false,
        background_color: '',
        tap_action: { action: 'toggle' },
        hold_action: { action: 'more-info' },
        v_min: 0,
        v_max: 100,
        v_step: 1,
        h_min: 0,
        h_max: 100,
        h_step: 0.5,
        ...config,
      };
      this._render();
    }

    set hass(hass) {
      this._hass = hass;
      this._updateState();
    }

    get hass() {
      return this._hass;
    }

    connectedCallback() {
      this._render();
    }

    _applySizes() {
      const activeIconSize = this._config && this._config.icon_size > 0 ? this._config.icon_size : 40;
      const activeTextSize = this._config && this._config.text_size > 0 ? this._config.text_size : 14;

      this.style.setProperty('--gesture-icon-size-pct', `${activeIconSize}%`);
      this.style.setProperty('--gesture-text-size', `${activeTextSize}px`);
    }

    _getAttrValue(entityState, attrName, defaultMin) {
      if (!entityState || !attrName) return defaultMin || 0;
      if (attrName === 'state') return parseFloat(entityState.state) || 0;
      if (entityState.attributes && entityState.attributes[attrName] !== undefined) {
        return parseFloat(entityState.attributes[attrName]) || 0;
      }
      return defaultMin || 0;
    }

    _onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (!this._config || !this._config.entity || !this._hass) return;

      const entityState = this._hass.states[this._config.entity];
      this._startX = e.clientX;
      this._startY = e.clientY;
      this._pointerId = e.pointerId;

      const card = e.currentTarget;
      if (card && card.setPointerCapture) {
        try {
          card.setPointerCapture(e.pointerId);
        } catch (_) {}
      }

      const vMin = this._config.v_min !== undefined ? Number(this._config.v_min) : 0;
      const hMin = this._config.h_min !== undefined ? Number(this._config.h_min) : 0;

      this._startVVal = this._getAttrValue(entityState, this._config.v_attribute, vMin);
      this._startHVal = this._getAttrValue(entityState, this._config.h_attribute, hMin);

      this._dragging = false;
      this._activeAxis = null;
      this._isHold = false;

      this._holdTimer = setTimeout(() => {
        this._isHold = true;
        this._dispatchAction('hold');
      }, 400);
    }

    _onPointerMove(e) {
      if (this._pointerId === null || e.pointerId !== this._pointerId) return;

      const deltaX = e.clientX - this._startX;
      const deltaY = e.clientY - this._startY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (distance > 5 && !this._dragging && !this._isHold) {
        if (this._holdTimer) {
          clearTimeout(this._holdTimer);
          this._holdTimer = null;
        }

        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);

        if (absY > absX && this._config.v_attribute) {
          this._activeAxis = 'v';
          this._dragging = true;
        } else if (absX >= absY && this._config.h_attribute) {
          this._activeAxis = 'h';
          this._dragging = true;
        }
      }

      if (this._dragging && this._activeAxis) {
        const card = this.shadowRoot.querySelector('ha-card');
        const rect = card ? card.getBoundingClientRect() : { width: 150, height: 150 };

        if (this._activeAxis === 'v') {
          const vMin = Number(this._config.v_min !== undefined ? this._config.v_min : 0);
          const vMax = Number(this._config.v_max !== undefined ? this._config.v_max : 100);
          const vStep = Number(this._config.v_step !== undefined ? this._config.v_step : 1);
          const range = vMax - vMin;
          const height = rect.height || 150;

          const deltaVal = -deltaY * (range / height);
          const rawVal = this._startVVal + deltaVal;
          const clampedVal = Math.min(vMax, Math.max(vMin, rawVal));
          const steppedVal = Math.round((clampedVal - vMin) / vStep) * vStep + vMin;
          const finalVal = formatValue(steppedVal, vStep);

          this._currentValue = finalVal;
          this._currentAttr = this._config.v_attribute;
          this._throttledServiceCall(finalVal, 'v');
        } else if (this._activeAxis === 'h') {
          const hMin = Number(this._config.h_min !== undefined ? this._config.h_min : 0);
          const hMax = Number(this._config.h_max !== undefined ? this._config.h_max : 100);
          const hStep = Number(this._config.h_step !== undefined ? this._config.h_step : 0.5);
          const range = hMax - hMin;
          const width = rect.width || 150;

          const deltaVal = deltaX * (range / width);
          const rawVal = this._startHVal + deltaVal;
          const clampedVal = Math.min(hMax, Math.max(hMin, rawVal));
          const steppedVal = Math.round((clampedVal - hMin) / hStep) * hStep + hMin;
          const finalVal = formatValue(steppedVal, hStep);

          this._currentValue = finalVal;
          this._currentAttr = this._config.h_attribute;
          this._throttledServiceCall(finalVal, 'h');
        }
        this._updatePill();
      }
    }

    _onPointerUp(e) {
      if (this._pointerId === null || e.pointerId !== this._pointerId) return;

      if (this._holdTimer) {
        clearTimeout(this._holdTimer);
        this._holdTimer = null;
      }

      const card = e.currentTarget;
      if (card && card.releasePointerCapture) {
        try {
          card.releasePointerCapture(e.pointerId);
        } catch (_) {}
      }

      if (this._dragging && this._activeAxis) {
        const attr = this._activeAxis === 'v' ? this._config.v_attribute : this._config.h_attribute;
        sendServiceCall(this._hass, this._config.entity, attr, this._currentValue);
        this._dragging = false;
        this._activeAxis = null;
        this._updatePill();
      } else if (!this._isHold) {
        this._dispatchAction('tap');
      }

      this._pointerId = null;
    }

    _onPointerCancel() {
      if (this._holdTimer) {
        clearTimeout(this._holdTimer);
        this._holdTimer = null;
      }
      this._dragging = false;
      this._activeAxis = null;
      this._pointerId = null;
      this._updatePill();
    }

    _throttledServiceCall(val, axis) {
      const now = Date.now();
      if (now - this._lastCallTime >= 180) {
        this._lastCallTime = now;
        const attr = axis === 'v' ? this._config.v_attribute : this._config.h_attribute;
        sendServiceCall(this._hass, this._config.entity, attr, val);
      }
    }

    _dispatchAction(actionType) {
      const event = new CustomEvent('hass-action', {
        bubbles: true,
        composed: true,
        detail: {
          config: this._config,
          action: actionType,
        },
      });
      this.dispatchEvent(event);
    }

    _getIconColor(stateObj) {
      if (!stateObj) return 'var(--paper-item-icon-color, var(--secondary-text-color, #727272))';
      const isActive = !['off', 'unavailable', 'unknown', 'closed', 'idle'].includes(stateObj.state);
      if (this._config.use_state_color_icon && isActive) {
        return getRawStateColor(stateObj);
      }
      if (this._config.icon_color) {
        return parseColor(this._config.icon_color);
      }
      return 'var(--paper-item-icon-color, var(--secondary-text-color, #727272))';
    }

    _getNameColor(stateObj) {
      if (!stateObj) return 'var(--primary-text-color)';
      const isActive = !['off', 'unavailable', 'unknown', 'closed', 'idle'].includes(stateObj.state);
      if (this._config && this._config.use_state_color_name && isActive) {
        return getRawStateColor(stateObj);
      }
      if (this._config && this._config.name_color) {
        return parseColor(this._config.name_color);
      }
      return 'var(--primary-text-color)';
    }

    _getBgColor(stateObj) {
      if (this._config && this._config.show_background === false) {
        return 'transparent';
      }
      const isActive = stateObj && !['off', 'unavailable', 'unknown', 'closed', 'idle'].includes(stateObj.state);
      if (this._config && this._config.use_state_color_bg) {
        if (isActive) {
          return getRawStateColor(stateObj);
        }
        return 'var(--ha-card-background, var(--card-background-color, #1c1c1e))';
      }
      if (this._config && this._config.background_color) {
        return parseColor(this._config.background_color);
      }
      return 'var(--ha-card-background, var(--card-background-color, #1c1c1e))';
    }

    _getDefaultIcon(domain) {
      const map = {
        light: 'mdi:lightbulb',
        cover: 'mdi:window-shutter',
        fan: 'mdi:fan',
        media_player: 'mdi:cast',
        climate: 'mdi:thermostat',
        number: 'mdi:numeric',
        input_number: 'mdi:ray-vertex',
      };
      return map[domain] || 'mdi:gesture-tap-button';
    }

    _updateState() {
      if (!this.shadowRoot || !this._config) return;
      if (!this._config.entity) {
        this._render();
        return;
      }

      const card = this.shadowRoot.querySelector('ha-card');
      if (!card) return;

      const stateObj = this._hass && this._config.entity ? this._hass.states[this._config.entity] : null;
      const domain = this._config.entity ? this._config.entity.split('.')[0] : '';

      const iconColor = this._getIconColor(stateObj);
      const nameColor = this._getNameColor(stateObj);
      const bgColor = this._getBgColor(stateObj);
      const isBgTransparent = this._config && this._config.show_background === false;

      const name = this._config.name !== undefined && this._config.name !== ''
        ? this._config.name
        : (stateObj && stateObj.attributes && stateObj.attributes.friendly_name) || this._config.entity || '';
      const icon = this._config.icon || (stateObj && stateObj.attributes && stateObj.attributes.icon) || this._getDefaultIcon(domain);

      card.style.background = bgColor;
      card.style.setProperty('--ha-card-background', bgColor);
      if (isBgTransparent) {
        card.style.boxShadow = 'none';
        card.style.border = 'none';
      } else {
        card.style.boxShadow = '';
        card.style.border = '';
      }

      const iconEl = this.shadowRoot.querySelector('ha-icon');
      if (iconEl) {
        iconEl.setAttribute('icon', icon);
        iconEl.style.color = iconColor;
      }

      const nameEl = this.shadowRoot.querySelector('.name-label');
      if (nameEl) {
        nameEl.textContent = name;
        nameEl.style.color = nameColor;
      }

      this._applySizes();
    }

    _updatePill() {
      let pill = this.shadowRoot.querySelector('.value-pill');
      if (this._dragging) {
        if (!pill) {
          pill = document.createElement('div');
          pill.className = 'value-pill';
          const card = this.shadowRoot.querySelector('ha-card');
          if (card) card.appendChild(pill);
        }
        const step = this._activeAxis === 'v' ? this._config.v_step : this._config.h_step;
        pill.innerHTML = `${formatValue(this._currentValue, step)} <span class="axis-indicator">(${this._currentAttr})</span>`;
      } else if (pill) {
        pill.remove();
      }
    }

    _render() {
      if (!this._config) return;

      if (!this._config.entity) {
        this.shadowRoot.innerHTML = `
          <style>
            :host {
              display: block;
              height: 100%;
              width: 100%;
            }
            ha-card.error-card {
              height: 100%;
              width: 100%;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 16px;
              box-sizing: border-box;
              background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
              border: 1px dashed var(--error-color, #db4437);
              color: var(--error-color, #db4437);
              border-radius: var(--ha-card-border-radius, 12px);
            }
            .error-message {
              display: flex;
              align-items: center;
              gap: 8px;
              font-size: 14px;
              font-weight: 500;
              text-align: center;
            }
          </style>
          <ha-card class="error-card">
            <div class="error-message">
              <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
              <span>Please select an entity</span>
            </div>
          </ha-card>
        `;
        return;
      }

      const stateObj = this._hass && this._config.entity ? this._hass.states[this._config.entity] : null;
      const domain = this._config.entity ? this._config.entity.split('.')[0] : '';
      const name = this._config.name !== undefined && this._config.name !== ''
        ? this._config.name
        : (stateObj && stateObj.attributes && stateObj.attributes.friendly_name) || this._config.entity || '';
      const icon = this._config.icon || (stateObj && stateObj.attributes && stateObj.attributes.icon) || this._getDefaultIcon(domain);

      const iconColor = this._getIconColor(stateObj);
      const nameColor = this._getNameColor(stateObj);
      const bgColor = this._getBgColor(stateObj);
      const isBgTransparent = this._config && this._config.show_background === false;

      const showIcon = this._config.show_icon !== false;
      const showName = this._config.show_name !== false;

      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: block;
            height: 100%;
            width: 100%;
          }
          ha-card {
            height: 100%;
            width: 100%;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 4px;
            box-sizing: border-box;
            position: relative;
            touch-action: none;
            user-select: none;
            -webkit-user-select: none;
            cursor: pointer;
            overflow: hidden;
            transition: background-color 0.2s ease, border-color 0.2s ease;
          }
          .card-content-wrapper {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 100%;
            gap: 2px;
            overflow: hidden;
          }
          .icon-container {
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            flex: 1 1 auto;
            width: 100%;
            height: 100%;
            min-height: 0;
            min-width: 0;
          }
          .icon-container ha-icon {
            --mdc-icon-size: 100%;
            --iron-icon-height: 100%;
            --iron-icon-width: 100%;
            width: var(--gesture-icon-size-pct, 40%);
            height: var(--gesture-icon-size-pct, 40%);
            max-width: 100%;
            max-height: 100%;
            aspect-ratio: 1 / 1;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .name-label {
            font-size: var(--gesture-text-size, 14px);
            line-height: 1.2;
            font-weight: 500;
            text-align: center;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            width: 100%;
            flex-shrink: 0;
            margin: 0;
            padding: 0 2px;
            box-sizing: border-box;
          }
          .value-pill {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.85);
            color: #ffffff;
            padding: 6px 14px;
            border-radius: 16px;
            font-size: 14px;
            font-weight: 600;
            letter-spacing: 0.5px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
            pointer-events: none;
            z-index: 10;
            backdrop-filter: blur(4px);
            white-space: nowrap;
          }
          .axis-indicator {
            font-size: 11px;
            opacity: 0.8;
            margin-left: 4px;
          }
        </style>
        <ha-card style="background: ${bgColor}; --ha-card-background: ${bgColor}; ${isBgTransparent ? 'box-shadow: none; border: none;' : ''}">
          <div class="card-content-wrapper">
            ${showIcon ? `<div class="icon-container"><ha-icon icon="${icon}" style="color: ${iconColor};"></ha-icon></div>` : ''}
            ${showName ? `<div class="name-label" style="color: ${nameColor};">${name}</div>` : ''}
          </div>
        </ha-card>
      `;

      const card = this.shadowRoot.querySelector('ha-card');
      if (card) {
        card.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        card.addEventListener('pointermove', (e) => this._onPointerMove(e));
        card.addEventListener('pointerup', (e) => this._onPointerUp(e));
        card.addEventListener('pointercancel', (e) => this._onPointerCancel(e));
      }

      this._applySizes();
    }

    static getConfigElement() {
      return document.createElement('gesture-card-editor');
    }

    static getStubConfig() {
      return {
        type: 'custom:gesture-card',
        entity: '',
        show_icon: true,
        show_name: true,
        show_background: true,
        icon_size: 40,
        text_size: 14,
        use_state_color_icon: true,
        use_state_color_name: false,
        use_state_color_bg: false,
        tap_action: { action: 'toggle' },
        hold_action: { action: 'more-info' },
        v_attribute: 'brightness',
        v_min: 0,
        v_max: 255,
        v_step: 1,
        h_attribute: 'color_temp_kelvin',
        h_min: 2000,
        h_max: 6500,
        h_step: 50,
      };
    }
  }

  class GestureCardEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._config = null;
      this._hass = null;
      this._rendered = false;
      this._updatingForms = false;
    }

    setConfig(config) {
      this._config = {
        entity: '',
        name: '',
        icon: '',
        show_icon: true,
        show_name: true,
        show_background: true,
        icon_size: 40,
        text_size: 14,
        use_state_color_icon: true,
        icon_color: '#ff9800',
        use_state_color_name: false,
        name_color: '',
        use_state_color_bg: false,
        background_color: '',
        tap_action: { action: 'toggle' },
        hold_action: { action: 'more-info' },
        v_attribute: '',
        v_min: 0,
        v_max: 100,
        v_step: 1,
        h_attribute: '',
        h_min: 0,
        h_max: 100,
        h_step: 0.5,
        ...config,
      };

      if (!this._rendered) {
        this._render();
      } else {
        this._updateForms();
      }
    }

    set hass(hass) {
      this._hass = hass;
      if (this._rendered) {
        this._updateForms();
      }
    }

    get hass() {
      return this._hass;
    }

    _valueChanged(ev) {
      ev.stopPropagation();
      if (this._updatingForms || !this._config || !this._hass) return;

      const value = ev.detail.value;
      if (!value) return;

      let newConfig = { ...this._config };

      const textKeys = ['name', 'icon', 'v_attribute', 'h_attribute'];
      textKeys.forEach((key) => {
        if (key in value) {
          newConfig[key] = value[key];
        }
      });

      Object.keys(value).forEach((key) => {
        newConfig[key] = value[key];
      });

      if (value.entity !== undefined && value.entity !== this._config.entity) {
        if (!value.entity) {
          newConfig.entity = '';
          newConfig.name = '';
          newConfig.icon = '';
          newConfig.v_attribute = '';
          newConfig.h_attribute = '';
        } else {
          const domain = value.entity ? value.entity.split('.')[0] : '';
          const entityState = this._hass.states[value.entity];
          const attrs = entityState ? entityState.attributes : {};

          if (entityState) {
            newConfig.name = attrs.friendly_name || '';
            newConfig.icon = attrs.icon || '';
          }

          if (domain === 'light') {
            newConfig.v_attribute = 'brightness';
            newConfig.v_min = 0;
            newConfig.v_max = 255;
            newConfig.v_step = 1;

            newConfig.h_attribute = 'color_temp_kelvin';
            newConfig.h_min = attrs.min_color_temp_kelvin !== undefined ? attrs.min_color_temp_kelvin : 2000;
            newConfig.h_max = attrs.max_color_temp_kelvin !== undefined ? attrs.max_color_temp_kelvin : 6500;
            newConfig.h_step = 50;
          } else if (domain === 'cover') {
            newConfig.v_attribute = 'position';
            newConfig.v_min = 0;
            newConfig.v_max = 100;
            newConfig.v_step = 1;
            newConfig.h_attribute = '';
          } else if (domain === 'fan') {
            newConfig.v_attribute = 'percentage';
            newConfig.v_min = 0;
            newConfig.v_max = 100;
            newConfig.v_step = 1;
            newConfig.h_attribute = '';
          } else if (domain === 'media_player') {
            newConfig.v_attribute = 'volume_level';
            newConfig.v_min = 0;
            newConfig.v_max = 1;
            newConfig.v_step = 0.05;
            newConfig.h_attribute = '';
          } else if (domain === 'climate') {
            newConfig.v_attribute = 'temperature';
            newConfig.v_min = 16;
            newConfig.v_max = 30;
            newConfig.v_step = 0.5;
            newConfig.h_attribute = '';
          } else if (domain === 'number' || domain === 'input_number') {
            newConfig.v_attribute = 'value';
            if (attrs.min !== undefined) newConfig.v_min = attrs.min;
            if (attrs.max !== undefined) newConfig.v_max = attrs.max;
            if (attrs.step !== undefined) newConfig.v_step = attrs.step;
            newConfig.h_attribute = '';
          }
        }
      }

      this._config = newConfig;
      this.dispatchEvent(
        new CustomEvent('config-changed', {
          detail: { config: this._config },
          bubbles: true,
          composed: true,
        })
      );
      this._updateForms();
    }

    _computeLabel(schema) {
      const labels = {
        entity: 'Entity',
        name: 'Name (Optional)',
        icon: 'Icon (Optional)',
        show_icon: '',
        icon_size: 'Size',
        use_state_color_icon: 'Use State Color',
        icon_color: 'Custom Color',
        show_name: '',
        text_size: 'Size',
        use_state_color_name: 'Use State Color',
        name_color: 'Custom Color',
        show_background: '',
        use_state_color_bg: 'Use State Color',
        background_color: 'Custom Color',
        tap_action: 'Tap Action',
        hold_action: 'Hold Action',
        v_attribute: 'Vertical Attribute',
        v_min: 'Min',
        v_max: 'Max',
        v_step: 'Step',
        h_attribute: 'Horizontal Attribute',
        h_min: 'Min',
        h_max: 'Max',
        h_step: 'Step',
      };
      return labels[schema.name] !== undefined ? labels[schema.name] : schema.name;
    }

    _getSchemas() {
      const entityId = this._config ? this._config.entity || '' : '';
      const showIcon = !!(this._config && this._config.show_icon !== false);
      const showName = !!(this._config && this._config.show_name !== false);
      const showBg = !!(this._config && this._config.show_background !== false);
      const useStateIcon = !!(this._config && this._config.use_state_color_icon);
      const useStateName = !!(this._config && this._config.use_state_color_name);
      const useStateBg = !!(this._config && this._config.use_state_color_bg);

      const mainSchema = [
        { name: 'entity', selector: { entity: {} } },
        { name: 'name', selector: { text: {} } },
        { name: 'icon', selector: { icon: {} } },
      ];

      const iconHeaderSchema = [{ name: 'show_icon', selector: { boolean: {} } }];

      const iconSchema = [];
      if (showIcon) {
        iconSchema.push({
          name: 'icon_size',
          selector: { number: { min: 10, max: 100, step: 1, mode: 'slider', unit_of_measurement: '%' } },
        });
        iconSchema.push(
          {
            type: 'grid',
            name: '',
            schema: [
              { 
                name: 'use_state_color_icon', 
                selector: { boolean: {} }
              },
              { 
                name: 'icon_color', 
                selector: { ui_color: {} },
                disabled: useStateIcon
              },
            ],
          }
        );
      }

      const nameHeaderSchema = [{ name: 'show_name', selector: { boolean: {} } }];

      const nameSchema = [];
      if (showName) {
        nameSchema.push({
          name: 'text_size',
          selector: { number: { min: 8, max: 36, step: 1, mode: 'slider', unit_of_measurement: 'px' } },
        });
        nameSchema.push(
          {
            type: 'grid',
            name: '',
            schema: [
              { 
                name: 'use_state_color_name', 
                selector: { boolean: {} }
              },
              { 
                name: 'name_color', 
                selector: { ui_color: {} },
                disabled: useStateName
              },
            ],
          }
        );
      }

      const bgHeaderSchema = [{ name: 'show_background', selector: { boolean: {} } }];

      const backgroundSchema = [];
      if (showBg) {
        backgroundSchema.push(
          {
            type: 'grid',
            name: '',
            schema: [
              { 
                name: 'use_state_color_bg', 
                selector: { boolean: {} }
              },
              { 
                name: 'background_color', 
                selector: { ui_color: {} },
                disabled: useStateBg
              },
            ],
          }
        );
      }

      const interactionsSchema = [
        { name: 'tap_action', selector: { ui_action: {} } },
        { name: 'hold_action', selector: { ui_action: {} } },
      ];

      const verticalSchema = [
        { name: 'v_attribute', selector: { attribute: { entity_id: entityId } } },
        {
          type: 'grid',
          name: '',
          column_min_width: '60px',
          schema: [
            { name: 'v_min', selector: { number: { mode: 'box', step: 'any' } } },
            { name: 'v_max', selector: { number: { mode: 'box', step: 'any' } } },
            { name: 'v_step', selector: { number: { mode: 'box', step: 'any' } } },
          ],
        },
      ];

      const horizontalSchema = [
        { name: 'h_attribute', selector: { attribute: { entity_id: entityId } } },
        {
          type: 'grid',
          name: '',
          column_min_width: '60px',
          schema: [
            { name: 'h_min', selector: { number: { mode: 'box', step: 'any' } } },
            { name: 'h_max', selector: { number: { mode: 'box', step: 'any' } } },
            { name: 'h_step', selector: { number: { mode: 'box', step: 'any' } } },
          ],
        },
      ];

      return {
        mainSchema,
        iconHeaderSchema,
        iconSchema,
        nameHeaderSchema,
        nameSchema,
        bgHeaderSchema,
        backgroundSchema,
        interactionsSchema,
        verticalSchema,
        horizontalSchema,
      };
    }

    _render() {
      if (!this._config) return;
      this._rendered = true;
      this.shadowRoot.innerHTML = `
        <style>
          .card-config {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }
          ha-expansion-panel {
            border: 1px solid var(--divider-color, #e0e0e0);
            border-radius: 8px;
            overflow: hidden;
          }
          .panel-content {
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 12px;
          }
          .section-card {
            border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.12));
            border-radius: 8px;
            padding: 12px;
            background: var(--secondary-background-color, rgba(255, 255, 255, 0.02));
          }
          .section-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            min-height: 40px;
          }
          .section-title {
            font-size: 1.1rem;
            font-weight: 600;
            margin: 0;
            color: var(--primary-text-color);
          }
          .section-header ha-form {
            margin: 0;
          }
        </style>
        <div class="card-config">
          <ha-form id="form-main"></ha-form>
          <ha-expansion-panel header="Appearance">
            <div class="panel-content">
              <div class="section-card">
                <div class="section-header">
                  <h3 class="section-title">Icon</h3>
                  <ha-form id="form-icon-toggle"></ha-form>
                </div>
                <ha-form id="form-appearance-icon"></ha-form>
              </div>
              <div class="section-card">
                <div class="section-header">
                  <h3 class="section-title">Name</h3>
                  <ha-form id="form-name-toggle"></ha-form>
                </div>
                <ha-form id="form-appearance-name"></ha-form>
              </div>
              <div class="section-card">
                <div class="section-header">
                  <h3 class="section-title">Background</h3>
                  <ha-form id="form-bg-toggle"></ha-form>
                </div>
                <ha-form id="form-appearance-bg"></ha-form>
              </div>
            </div>
          </ha-expansion-panel>
          <ha-expansion-panel header="Interactions">
            <div class="panel-content">
              <ha-form id="form-interactions"></ha-form>
            </div>
          </ha-expansion-panel>
          <ha-expansion-panel header="Vertical Gesture">
            <div class="panel-content">
              <ha-form id="form-vertical"></ha-form>
            </div>
          </ha-expansion-panel>
          <ha-expansion-panel header="Horizontal Gesture">
            <div class="panel-content">
              <ha-form id="form-horizontal"></ha-form>
            </div>
          </ha-expansion-panel>
        </div>
      `;

      const setupForm = (selector) => {
        const form = this.shadowRoot.querySelector(selector);
        if (form) {
          form.computeLabel = (s) => this._computeLabel(s);
          form.addEventListener('value-changed', (e) => this._valueChanged(e));
        }
      };

      setupForm('#form-main');
      setupForm('#form-icon-toggle');
      setupForm('#form-appearance-icon');
      setupForm('#form-name-toggle');
      setupForm('#form-appearance-name');
      setupForm('#form-bg-toggle');
      setupForm('#form-appearance-bg');
      setupForm('#form-interactions');
      setupForm('#form-vertical');
      setupForm('#form-horizontal');

      this._updateForms();
    }

    _styleForm(form) {
      if (!form) return;
      const applyStyle = () => {
        if (!form.shadowRoot) return;
        let styleEl = form.shadowRoot.querySelector('#gesture-card-form-style');
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = 'gesture-card-form-style';
          form.shadowRoot.appendChild(styleEl);
        }
        styleEl.textContent = `
          .grid, .root > .grid, :host([type="grid"]) {
            display: grid !important;
            grid-template-columns: minmax(110px, 1fr) 2fr !important;
            gap: 12px !important;
            align-items: center !important;
          }
        `;
      };
      applyStyle();
      setTimeout(applyStyle, 0);
    }

    _updateForms() {
      if (!this._config || !this.shadowRoot) return;
      this._updatingForms = true;
      try {
        const {
          mainSchema,
          iconHeaderSchema,
          iconSchema,
          nameHeaderSchema,
          nameSchema,
          bgHeaderSchema,
          backgroundSchema,
          interactionsSchema,
          verticalSchema,
          horizontalSchema,
        } = this._getSchemas();

        const updateForm = (id, schema) => {
          const form = this.shadowRoot.querySelector(id);
          if (form) {
            form.hass = this._hass;
            form.data = this._config;
            form.schema = schema;
            this._styleForm(form);
          }
        };

        updateForm('#form-main', mainSchema);
        updateForm('#form-icon-toggle', iconHeaderSchema);
        updateForm('#form-appearance-icon', iconSchema);
        updateForm('#form-name-toggle', nameHeaderSchema);
        updateForm('#form-appearance-name', nameSchema);
        updateForm('#form-bg-toggle', bgHeaderSchema);
        updateForm('#form-appearance-bg', backgroundSchema);
        updateForm('#form-interactions', interactionsSchema);
        updateForm('#form-vertical', verticalSchema);
        updateForm('#form-horizontal', horizontalSchema);
      } finally {
        this._updatingForms = false;
      }
    }
  }

  customElements.define('gesture-card', GestureCard);
  customElements.define('gesture-card-editor', GestureCardEditor);

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'gesture-card',
    name: 'Gesture Card',
    description: 'Interactive tile card supporting 2D swipe and drag gestures for Home Assistant attributes.',
    preview: true,
  });
})();