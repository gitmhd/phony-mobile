/* eslint-disable react-native/no-inline-styles */
import 'fast-text-encoding'; // <-- Line 1: Enforces TextDecoder/TextEncoder for WebRTC in Hermes/background
import React, { useEffect, useState } from 'react';
import {
  SafeAreaView,
  Text,
  TouchableOpacity,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  View,
  StatusBar,
  Alert,
  Linking,
} from 'react-native';
import BackgroundService from 'react-native-background-actions';
import Geolocation from 'react-native-geolocation-service';
import { createClient } from '@supabase/supabase-js';
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
  MediaStream,
} from 'react-native-webrtc';

// -------------------------------------------------------------
// 1. SUPABASE CLIENT & CONFIGURATION
// -------------------------------------------------------------
const SUPABASE_URL = 'https://nvgmqbuswzkmnhcrpyti.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im52Z21xYnVzd3prbW5oY3JweXRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5NDg5NDUsImV4cCI6MjEwNTUyNDk0NX0.h64PbG7LttbzQwuisF8c6b1NqRIYGYyIL-k-npiJWmA';
const DEVICE_ID = 'phony-device';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let activePeerConnection: RTCPeerConnection | null = null;
let currentMediaStream: MediaStream | null = null;
let activeVideoTrack: any = null;

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(() => resolve(), ms));

// Helper: Query current GPS fix via Promise
const getDevicePosition = (): Promise<Geolocation.GeoPosition> => {
  return new Promise((resolve, reject) => {
    Geolocation.getCurrentPosition(
      pos => resolve(pos),
      err => reject(err),
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 5000,
        forceRequestLocation: true,
      },
    );
  });
};

// -------------------------------------------------------------
// 2. HEADLESS WEBRTC STREAMING HANDLERS
// -------------------------------------------------------------
const startHeadlessStream = async (channel: any) => {
  try {
    console.log('[Phony] Starting headless media capture...');

    if (currentMediaStream) {
      currentMediaStream.getTracks().forEach(t => t.stop());
    }
    if (activePeerConnection) {
      activePeerConnection.close();
    }

    const stream = (await mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: 'environment', // Starts on rear camera
        frameRate: 20,
      },
    })) as MediaStream;

    currentMediaStream = stream;
    activeVideoTrack = stream.getVideoTracks()[0];

    const pc = new RTCPeerConnection(rtcConfig);
    activePeerConnection = pc;

    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    pc.onicecandidate = (event: any) => {
      if (event.candidate) {
        channel.send({
          type: 'broadcast',
          event: 'ice_candidate',
          payload: { candidate: event.candidate, sender: 'device' },
        });
      }
    };

    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);

    await channel.send({
      type: 'broadcast',
      event: 'webrtc_offer',
      payload: { offer },
    });

    console.log('[Phony] Offer broadcasted from background thread.');
  } catch (err) {
    console.error('[Phony] Error starting headless stream:', err);
  }
};

const handleRemoteCameraSwitch = () => {
  if (
    activeVideoTrack &&
    typeof activeVideoTrack._switchCamera === 'function'
  ) {
    activeVideoTrack._switchCamera();
    console.log('[Phony] Remotely switched camera lens.');
  } else {
    console.warn('[Phony] Cannot switch camera: No active video track found.');
  }
};

const stopHeadlessStream = () => {
  if (currentMediaStream) {
    currentMediaStream.getTracks().forEach(t => t.stop());
    currentMediaStream = null;
  }
  activeVideoTrack = null;
  if (activePeerConnection) {
    activePeerConnection.close();
    activePeerConnection = null;
  }
  console.log('[Phony] Headless stream stopped.');
};

// -------------------------------------------------------------
// 3. FOREGROUND TASK EXECUTOR (Persistent background thread)
// -------------------------------------------------------------
const backgroundPhonyBeacon = async () => {
  console.log('[Phony] Background Service started. Subscribing to Supabase...');

  const channel = supabase.channel('phony_device_listener');

  // A. Handle DB table pings for location
  channel.on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'ping_requests',
    },
    async payload => {
      const row = payload.new;
      if (row.device_id === DEVICE_ID && row.status === 'pending') {
        try {
          const position = await getDevicePosition();
          await supabase
            .from('ping_requests')
            .update({
              status: 'completed',
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
              completed_at: new Date().toISOString(),
            })
            .eq('id', row.id);
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (locationErr) {
          await supabase
            .from('ping_requests')
            .update({ status: 'failed' })
            .eq('id', row.id);
        }
      }
    },
  );

  // B. Handle live stream signaling broadcasts
  channel
    .on('broadcast', { event: 'start_stream' }, async () => {
      await startHeadlessStream(channel);
    })
    .on('broadcast', { event: 'stop_stream' }, () => {
      stopHeadlessStream();
    })
    .on('broadcast', { event: 'switch_camera' }, () => {
      handleRemoteCameraSwitch();
    })
    .on('broadcast', { event: 'webrtc_answer' }, async ({ payload }) => {
      if (activePeerConnection && payload.answer) {
        await activePeerConnection.setRemoteDescription(
          new RTCSessionDescription(payload.answer),
        );
      }
    })
    .on('broadcast', { event: 'ice_candidate' }, async ({ payload }) => {
      if (
        activePeerConnection &&
        payload.candidate &&
        payload.sender === 'web'
      ) {
        await activePeerConnection.addIceCandidate(
          new RTCIceCandidate(payload.candidate),
        );
      }
    });

  channel.subscribe();

  while (BackgroundService.isRunning()) {
    await sleep(5000);
  }

  stopHeadlessStream();
  supabase.removeChannel(channel);
};

// -------------------------------------------------------------
// 4. MAIN UI COMPONENT
// -------------------------------------------------------------
export default function App() {
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    setIsRunning(BackgroundService.isRunning());
  }, []);

  const enforcePermissions = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;

    // 1. Notification permission
    if (Platform.Version >= 33) {
      const notifGranted = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
      if (!notifGranted) {
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        );
      }
    }

    // 2. Hardware permissions (Camera & Microphone)
    const hardwarePermissions = [
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    ];
    await PermissionsAndroid.requestMultiple(hardwarePermissions);

    // 3. Foreground Location
    const fineGranted = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    );

    if (!fineGranted) {
      const fineResult = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
      ]);

      if (
        fineResult[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] !==
        PermissionsAndroid.RESULTS.GRANTED
      ) {
        Alert.alert(
          'Location Required',
          'Phony requires location access to respond to coordinates.',
        );
        return false;
      }
    }

    // 4. Enforce "Allow all the time"
    if (Platform.Version >= 29) {
      const bgGranted = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
      );

      if (!bgGranted) {
        return new Promise(resolve => {
          Alert.alert(
            'Background Access Required',
            'To receive pings and stream while locked, location must be set to "Allow all the time".',
            [
              {
                text: 'Cancel',
                style: 'cancel',
                onPress: () => resolve(false),
              },
              {
                text: 'Set "Allow all the time"',
                onPress: async () => {
                  try {
                    const bgResult = await PermissionsAndroid.request(
                      PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
                    );
                    if (bgResult === PermissionsAndroid.RESULTS.GRANTED) {
                      resolve(true);
                    } else {
                      Alert.alert(
                        'Permission Denied',
                        'Please select "Allow all the time" in App Settings.',
                        [
                          { text: 'Cancel', onPress: () => resolve(false) },
                          {
                            text: 'Open Settings',
                            onPress: () => {
                              Linking.openSettings();
                              resolve(false);
                            },
                          },
                        ],
                      );
                    }
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  } catch (e) {
                    resolve(false);
                  }
                },
              },
            ],
          );
        });
      }
    }

    return true;
  };

  const startBeacon = async () => {
    const hasPermission = await enforcePermissions();
    if (!hasPermission) return;

    const options = {
      taskName: 'PhonyBeacon',
      taskTitle: 'Phony Beacon Active',
      taskDesc: 'Listening for remote location & stream requests...',
      taskIcon: { name: 'ic_launcher', type: 'mipmap' },
      color: '#2563eb',
      linkingURI: 'phony://',
      parameters: { delay: 5000 },
    };

    try {
      await BackgroundService.start(backgroundPhonyBeacon, options);
      setIsRunning(true);
    } catch (e) {
      console.error('[Phony] Service start error:', e);
    }
  };

  const stopBeacon = async () => {
    try {
      await BackgroundService.stop();
      setIsRunning(false);
    } catch (e) {
      console.error('[Phony] Service stop error:', e);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.card}>
        <Text style={styles.appName}>PHONY</Text>
        <Text style={styles.deviceIdLabel}>
          Device ID: <Text style={styles.deviceIdValue}>{DEVICE_ID}</Text>
        </Text>

        <View style={styles.statusBox}>
          <View
            style={[
              styles.statusIndicator,
              { backgroundColor: isRunning ? '#22c55e' : '#ef4444' },
            ]}
          />
          <Text style={styles.statusText}>
            {isRunning ? 'Service Running (Listening)' : 'Service Idle'}
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.btn, isRunning ? styles.btnStop : styles.btnStart]}
          onPress={isRunning ? stopBeacon : startBeacon}
          activeOpacity={0.8}
        >
          <Text style={styles.btnText}>
            {isRunning ? 'Deactivate Beacon' : 'Activate Beacon'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#020617',
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    width: '88%',
    backgroundColor: '#0f172a',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1e293b',
    elevation: 4,
  },
  appName: {
    fontSize: 26,
    fontWeight: '800',
    color: '#f8fafc',
    letterSpacing: 2,
  },
  deviceIdLabel: {
    fontSize: 13,
    color: '#64748b',
    marginTop: 4,
    marginBottom: 20,
  },
  deviceIdValue: {
    color: '#38bdf8',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
    fontWeight: '600',
  },
  statusBox: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 28,
    backgroundColor: '#1e293b',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 9999,
  },
  statusIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '500',
  },
  btn: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnStart: {
    backgroundColor: '#2563eb',
  },
  btnStop: {
    backgroundColor: '#dc2626',
  },
  btnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
});
