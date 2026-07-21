import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import App from './App';
import { checkEnv, StartupErrorView } from './EnvGate';
import './responsive.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);
const result = checkEnv();

if (!result.ok) {
  root.render(
    <React.StrictMode>
      <StartupErrorView missing={result.missing} />
    </React.StrictMode>,
  );
} else {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: import.meta.env.VITE_USER_POOL_ID,
        userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
        identityPoolId: import.meta.env.VITE_IDENTITY_POOL_ID,
      },
    },
  });

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
