(function () {
  const LitElement = window.LitElement || Object.getPrototypeOf(customElements.get('ha-panel-lovelace'));
  const html = window.html || LitElement.prototype.html;
  const css = window.css || LitElement.prototype.css;

  function parseColor(color) {
    if (!color) return '';
    if (color.startsWith('#') || color.startsWith('rgb') || color.startsWith('hsl') || color.startsWith('var(')) {
      return color;
    }
    const haColors = [
      'primary', 'accent', 'disabled',
      'red', 'pink', 'purple', 'deep-purple', 'indigo', 'blue',
      'light-blue', 'cyan', 'teal', 'green', 'light-green', 'lime',
      'yellow', 'amber', 'orange', 'deep-orange', 'brown', 'grey', 'blue-grey'
    ];
    if (haColors.includes(color)) {
      return `var(--${color}-color, ${color})`;
    }
    return color;
  }

  function getEntityStateColor(stateObj) {
    if (!stateObj) return '';
    const domain = stateObj.entity_id ? stateObj.entity_id.split('.')[0] : '';
    const isActive = !['off', 'unavailable', 'unknown', 'closed', 'idle'].includes(stateObj.state);

    if (!isActive) {
      return 'var(--state-icon-color, var(--paper-item-icon-color, var(--secondary-text-color)))';
    }

    if (stateObj.attributes && Array.isArray(stateObj.attributes.rgb_color)) {
      return `rgb(${stateObj.attributes.rgb_color.join(',')})`;
    }

    return `var(--state-${domain}-active-color, var(--state-icon-active-color, var(--state-active-color, var(--paper-item-icon-active-color, #ffc107))))`;
  }

  function sendServiceCall(hass, entityId, attribute, value) {
    if (!hass || !entityId) return;
    const domain = entityId.split('.')[0];
    const serviceMap = {
      light: { service: 'turn_on', key: attribute || 'brightness' },
      cover: { service: 'set_cover_position', key: 'position' },
      fan: { service: 'set_percentage', key: 'percentage' },
      media_player: { service: 'volume_set', key: 'volume_level' },
      climate: { service: 'set_temperature', key: 'temperature' },
      number: { service: 'set_value', key: 'value' },
      input_number: { service: 'set_value', key: 'value' },
    };

    const mapping = serviceMap[domain] || { service: 'turn_on', key: attribute };
    const payload = { entity_id: entityId };
    if (mapping.key) {
      payload[mapping.key] = value;
    }

    hass.callService(domain, mapping.service, payload);
  }

  function formatValue(val, step = 1) {
    const stepStr = step.toString();
    const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
    return Number(val.toFixed(decimals));
  }

  class GestureCard extends LitElement {
    static get properties() {
      return {
        hass: { type: Object },
        _config: { type: Object },
        _dragging: { type: Boolean },
        _currentValue: { type: Number },
        _currentAttr: { type: String },
      };
    }

    constructor() {
      super();
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
        icon_color: '',
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
      this.requestUpdate();
    }

    getCardSize() {
      return 2;
    }

    static get styles() {
      return css`
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
        ha-card.transparent {
          box-shadow: none;
          border: none;
        }
        ha-card.error-card {
          border: 1px dashed var(--error-color, #db4437);
          color: var(--error-color, #db4437);
          border-radius: var(--ha-card-border-radius, 12px);
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
          transition: color 0.2s ease;
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
          transition: color 0.2s ease;
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
        .error-message {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
          font-weight: 500;
          text-align: center;
        }
      `;
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
      if (!this._config || !this._config.entity || !this.hass) return;

      const entityState = this.hass.states[this._config.entity];
      this._startX = e.clientX;
      this._startY = e.clientY;
      this._pointerId = e.pointerId;

      if (e.currentTarget && e.currentTarget.setPointerCapture) {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch (_) {}
      }

      const vMin = Number(this._config.v_min ?? 0);
      const hMin = Number(this._config.h_min ?? 0);

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
          const vMin = Number(this._config.v_min ?? 0);
          const vMax = Number(this._config.v_max ?? 100);
          const vStep = Number(this._config.v_step ?? 1);
          const range = vMax - vMin;
          const height = rect.height || 150;

          const deltaVal = -deltaY * (range / height);
          const rawVal = this._startVVal + deltaVal;
          const clampedVal = Math.min(vMax, Math.max(vMin, rawVal));
          const steppedVal = Math.round((clampedVal - vMin) / vStep) * vStep + vMin;

          this._currentValue = formatValue(steppedVal, vStep);
          this._currentAttr = this._config.v_attribute;
          this._throttledServiceCall(this._currentValue, 'v');
        } else if (this._activeAxis === 'h') {
          const hMin = Number(this._config.h_min ?? 0);
          const hMax = Number(this._config.h_max ?? 100);
          const hStep = Number(this._config.h_step ?? 0.5);
          const range = hMax - hMin;
          const width = rect.width || 150;

          const deltaVal = deltaX * (range / width);
          const rawVal = this._startHVal + deltaVal;
          const clampedVal = Math.min(hMax, Math.max(hMin, rawVal));
          const steppedVal = Math.round((clampedVal - hMin) / hStep) * hStep + hMin;

          this._currentValue = formatValue(steppedVal, hStep);
          this._currentAttr = this._config.h_attribute;
          this._throttledServiceCall(this._currentValue, 'h');
        }
      }
    }

    _onPointerUp(e) {
      if (this._pointerId === null || e.pointerId !== this._pointerId) return;

      if (this._holdTimer) {
        clearTimeout(this._holdTimer);
        this._holdTimer = null;
      }

      if (e.currentTarget && e.currentTarget.releasePointerCapture) {
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch (_) {}
      }

      if (this._dragging && this._activeAxis) {
        const attr = this._activeAxis === 'v' ? this._config.v_attribute : this._config.h_attribute;
        sendServiceCall(this.hass, this._config.entity, attr, this._currentValue);
        this._dragging = false;
        this._activeAxis = null;
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
    }

    _throttledServiceCall(val, axis) {
      const now = Date.now();
      if (now - this._lastCallTime >= 180) {
        this._lastCallTime = now;
        const attr = axis === 'v' ? this._config.v_attribute : this._config.h_attribute;
        sendServiceCall(this.hass, this._config.entity, attr, val);
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

    _computeStyles(stateObj) {
      const isActive = stateObj && !['off', 'unavailable', 'unknown', 'closed', 'idle'].includes(stateObj.state);

      let iconColor = '';
      if (this._config.use_state_color_icon) {
        iconColor = getEntityStateColor(stateObj);
      } else if (this._config.icon_color) {
        iconColor = parseColor(this._config.icon_color);
      } else {
        iconColor = 'var(--paper-item-icon-color, var(--secondary-text-color))';
      }

      let nameColor = '';
      if (this._config.use_state_color_name) {
        nameColor = getEntityStateColor(stateObj);
      } else if (this._config.name_color) {
        nameColor = parseColor(this._config.name_color);
      } else {
        nameColor = 'var(--primary-text-color)';
      }

      let bgColor = '';
      if (this._config.show_background === false) {
        bgColor = 'transparent';
      } else if (this._config.use_state_color_bg) {
        bgColor = isActive
          ? getEntityStateColor(stateObj)
          : 'var(--ha-card-background, var(--card-background-color, #1c1c1e))';
      } else if (this._config.background_color) {
        bgColor = parseColor(this._config.background_color);
      } else {
        bgColor = 'var(--ha-card-background, var(--card-background-color, #1c1c1e))';
      }

      return { iconColor, nameColor, bgColor };
    }

    render() {
      if (!this._config) return html``;

      if (!this._config.entity) {
        return html`
          <ha-card class="error-card">
            <div class="error-message">
              <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
              <span>Please select an entity</span>
            </div>
          </ha-card>
        `;
      }

      const stateObj = this.hass && this._config.entity ? this.hass.states[this._config.entity] : null;
      const domain = this._config.entity ? this._config.entity.split('.')[0] : '';
      const name = this._config.name || (stateObj?.attributes?.friendly_name) || this._config.entity;
      const icon = this._config.icon || stateObj?.attributes?.icon || this._getDefaultIcon(domain);

      const { iconColor, nameColor, bgColor } = this._computeStyles(stateObj);
      const isTransparent = this._config.show_background === false;

      const iconSize = this._config.icon_size > 0 ? this._config.icon_size : 40;
      const textSize = this._config.text_size > 0 ? this._config.text_size : 14;

      const step = this._activeAxis === 'v' ? this._config.v_step : this._config.h_step;

      return html`
        <ha-card
          class="${isTransparent ? 'transparent' : ''}"
          style="background: ${bgColor}; --gesture-icon-size-pct: ${iconSize}%; --gesture-text-size: ${textSize}px;"
          @pointerdown="${this._onPointerDown}"
          @pointermove="${this._onPointerMove}"
          @pointerup="${this._onPointerUp}"
          @pointercancel="${this._onPointerCancel}"
        >
          <div class="card-content-wrapper">
            ${this._config.show_icon !== false
              ? html`
                  <div class="icon-container">
                    <ha-icon .icon="${icon}" style="color: ${iconColor};"></ha-icon>
                  </div>
                `
              : ''}
            ${this._config.show_name !== false
              ? html`<div class="name-label" style="color: ${nameColor};">${name}</div>`
              : ''}
          </div>
          ${this._dragging
            ? html`
                <div class="value-pill">
                  ${formatValue(this._currentValue, step)}
                  <span class="axis-indicator">(${this._currentAttr})</span>
                </div>
              `
            : ''}
        </ha-card>
      `;
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

  class GestureCardEditor extends LitElement {
    static get properties() {
      return {
        hass: { type: Object },
        _config: { type: Object },
      };
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
        icon_color: '',
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
    }

    static get styles() {
      return css`
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
          margin-bottom: 8px;
        }
        .section-header.closed {
          margin-bottom: 0;
        }
        .section-title {
          font-size: 1rem;
          font-weight: 600;
          margin: 0;
          color: var(--primary-text-color);
        }
      `;
    }

    _toggleSwitch(key, checked) {
      this._config = {
        ...this._config,
        [key]: checked,
      };
      this.dispatchEvent(
        new CustomEvent('config-changed', {
          detail: { config: this._config },
          bubbles: true,
          composed: true,
        })
      );
    }

    _valueChanged(ev) {
      ev.stopPropagation();
      if (!this._config || !this.hass) return;

      const value = ev.detail.value;
      if (!value) return;

      let newConfig = { ...this._config, ...value };

      if (value.entity !== undefined && value.entity !== this._config.entity) {
        if (!value.entity) {
          newConfig.entity = '';
          newConfig.name = '';
          newConfig.icon = '';
          newConfig.v_attribute = '';
          newConfig.h_attribute = '';
        } else {
          const domain = value.entity.split('.')[0];
          const entityState = this.hass.states[value.entity];
          const attrs = entityState?.attributes || {};

          newConfig.name = attrs.friendly_name || '';
          newConfig.icon = attrs.icon || '';

          if (domain === 'light') {
            newConfig.v_attribute = 'brightness';
            newConfig.v_min = 0;
            newConfig.v_max = 255;
            newConfig.v_step = 1;
            newConfig.h_attribute = 'color_temp_kelvin';
            newConfig.h_min = attrs.min_color_temp_kelvin ?? 2000;
            newConfig.h_max = attrs.max_color_temp_kelvin ?? 6500;
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
    }

    _computeLabel(schema) {
      const labels = {
        entity: 'Entity',
        name: 'Name (Optional)',
        icon: 'Icon (Optional)',
        icon_size: 'Size',
        use_state_color_icon: 'Use State Color',
        icon_color: 'Custom Color',
        text_size: 'Size',
        use_state_color_name: 'Use State Color',
        name_color: 'Custom Color',
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

    render() {
      if (!this._config || !this.hass) return html``;

      const entityId = this._config.entity || '';
      const showIcon = this._config.show_icon !== false;
      const showName = this._config.show_name !== false;
      const showBg = this._config.show_background !== false;

      const mainSchema = [
        { name: 'entity', selector: { entity: {} } },
        { name: 'name', selector: { text: {} } },
        { name: 'icon', selector: { icon: {} } },
      ];

      const iconSchema = showIcon
        ? [
            {
              name: 'icon_size',
              selector: { number: { min: 10, max: 100, step: 1, mode: 'slider', unit_of_measurement: '%' } },
            },
            {
              type: 'grid',
              name: '',
              schema: [
                { name: 'use_state_color_icon', selector: { boolean: {} } },
                { name: 'icon_color', selector: { ui_color: {} }, disabled: !!this._config.use_state_color_icon },
              ],
            },
          ]
        : [];

      const nameSchema = showName
        ? [
            {
              name: 'text_size',
              selector: { number: { min: 8, max: 36, step: 1, mode: 'slider', unit_of_measurement: 'px' } },
            },
            {
              type: 'grid',
              name: '',
              schema: [
                { name: 'use_state_color_name', selector: { boolean: {} } },
                { name: 'name_color', selector: { ui_color: {} }, disabled: !!this._config.use_state_color_name },
              ],
            },
          ]
        : [];

      const backgroundSchema = showBg
        ? [
            {
              type: 'grid',
              name: '',
              schema: [
                { name: 'use_state_color_bg', selector: { boolean: {} } },
                { name: 'background_color', selector: { ui_color: {} }, disabled: !!this._config.use_state_color_bg },
              ],
            },
          ]
        : [];

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
            { name: 'h_min', selector: { mode: 'box', step: 'any' } },
            { name: 'h_max', selector: { mode: 'box', step: 'any' } },
            { name: 'h_step', selector: { mode: 'box', step: 'any' } },
          ],
        },
      ];

      return html`
        <div class="card-config">
          <ha-form
            .hass="${this.hass}"
            .data="${this._config}"
            .schema="${mainSchema}"
            .computeLabel="${this._computeLabel}"
            @value-changed="${this._valueChanged}"
          ></ha-form>

          <ha-expansion-panel header="Appearance">
            <div class="panel-content">
              <div class="section-card">
                <div class="section-header ${!showIcon ? 'closed' : ''}">
                  <h3 class="section-title">Icon</h3>
                  <ha-switch
                    .checked="${showIcon}"
                    @change="${(e) => this._toggleSwitch('show_icon', e.target.checked)}"
                  ></ha-switch>
                </div>
                ${showIcon
                  ? html`
                      <ha-form
                        .hass="${this.hass}"
                        .data="${this._config}"
                        .schema="${iconSchema}"
                        .computeLabel="${this._computeLabel}"
                        @value-changed="${this._valueChanged}"
                      ></ha-form>
                    `
                  : ''}
              </div>

              <div class="section-card">
                <div class="section-header ${!showName ? 'closed' : ''}">
                  <h3 class="section-title">Name</h3>
                  <ha-switch
                    .checked="${showName}"
                    @change="${(e) => this._toggleSwitch('show_name', e.target.checked)}"
                  ></ha-switch>
                </div>
                ${showName
                  ? html`
                      <ha-form
                        .hass="${this.hass}"
                        .data="${this._config}"
                        .schema="${nameSchema}"
                        .computeLabel="${this._computeLabel}"
                        @value-changed="${this._valueChanged}"
                      ></ha-form>
                    `
                  : ''}
              </div>

              <div class="section-card">
                <div class="section-header ${!showBg ? 'closed' : ''}">
                  <h3 class="section-title">Background</h3>
                  <ha-switch
                    .checked="${showBg}"
                    @change="${(e) => this._toggleSwitch('show_background', e.target.checked)}"
                  ></ha-switch>
                </div>
                ${showBg
                  ? html`
                      <ha-form
                        .hass="${this.hass}"
                        .data="${this._config}"
                        .schema="${backgroundSchema}"
                        .computeLabel="${this._computeLabel}"
                        @value-changed="${this._valueChanged}"
                      ></ha-form>
                    `
                  : ''}
              </div>
            </div>
          </ha-expansion-panel>

          <ha-expansion-panel header="Interactions">
            <div class="panel-content">
              <ha-form
                .hass="${this.hass}"
                .data="${this._config}"
                .schema="${interactionsSchema}"
                .computeLabel="${this._computeLabel}"
                @value-changed="${this._valueChanged}"
              ></ha-form>
            </div>
          </ha-expansion-panel>

          <ha-expansion-panel header="Vertical Gesture">
            <div class="panel-content">
              <ha-form
                .hass="${this.hass}"
                .data="${this._config}"
                .schema="${verticalSchema}"
                .computeLabel="${this._computeLabel}"
                @value-changed="${this._valueChanged}"
              ></ha-form>
            </div>
          </ha-expansion-panel>

          <ha-expansion-panel header="Horizontal Gesture">
            <div class="panel-content">
              <ha-form
                .hass="${this.hass}"
                .data="${this._config}"
                .schema="${horizontalSchema}"
                .computeLabel="${this._computeLabel}"
                @value-changed="${this._valueChanged}"
              ></ha-form>
            </div>
          </ha-expansion-panel>
        </div>
      `;
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
