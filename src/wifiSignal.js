// Wi-Fi signal of the units' adapters.
//
// It does not come with the unit settings of `/context` (its top-level `rssi`
// stopped updating in September 2026) but from a telemetry series, one request
// per unit: it is read every WIFI_SIGNAL_INTERVAL, not on every poll. A reading
// is published once, with the time the adapter took it, so the history shows
// when the signal moved rather than when it was fetched.

import { logger } from '@gladysassistant/integration-sdk';

export const WIFI_SIGNAL_INTERVAL = 30 * 60 * 1000;

/**
 * Build the reader that turns the newest reading of each unit into a state to
 * publish, once per reading.
 * @param {object} options - Options.
 * @param {Function} options.getWifiSignal - (unitId) => Promise<{value, time}|null>.
 * @returns {{read: Function, forget: Function}} The reader.
 */
export function createWifiSignalReader({ getWifiSignal }) {
  // Time of the last reading published, by feature external id.
  const published = new Map();

  return {
    /**
     * Read a unit's signal.
     * @param {string} unitId - The MELCloud unit id.
     * @param {string} featureExternalId - The Gladys feature to publish it to.
     * @returns {Promise<object|null>} The state to publish, or null when there
     *   is no reading newer than the last one published, or the request failed.
     */
    async read(unitId, featureExternalId) {
      let reading;
      try {
        reading = await getWifiSignal(unitId);
      } catch (e) {
        logger.warn(`MELCloud Home: no Wi-Fi signal for unit ${unitId}: ${e.message}`);
        return null;
      }
      if (!reading) {
        return null;
      }
      const time = reading.time.getTime();
      if (published.has(featureExternalId) && published.get(featureExternalId) >= time) {
        return null;
      }
      published.set(featureExternalId, time);
      return {
        device_feature_external_id: featureExternalId,
        state: reading.value,
        created_at: reading.time.toISOString(),
      };
    },

    /**
     * Forget what was published, so the next read publishes again (another
     * account, or devices created again).
     * @returns {void} Nothing.
     */
    forget() {
      published.clear();
    },
  };
}
