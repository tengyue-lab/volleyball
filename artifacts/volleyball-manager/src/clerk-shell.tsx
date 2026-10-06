import type { ReactNode } from 'react';
import { ClerkProvider, SignIn, SignUp } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { Route, Switch, useLocation } from 'wouter';

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#245c4c',
    colorForeground: '#1d2d3c',
    colorMutedForeground: '#5f6e78',
    colorDanger: '#b23a35',
    colorBackground: '#fcfbf6',
    colorInput: '#f6f3ea',
    colorInputForeground: '#1d2d3c',
    colorNeutral: '#1d2d3c',
    fontFamily: "'Manrope', sans-serif",
    borderRadius: '0.5rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fcfbf6] border border-[#ddd6c6] rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#1d2d3c] font-extrabold tracking-tight',
    headerSubtitle: 'text-[#5f6e78]',
    socialButtonsBlockButtonText: 'text-[#1d2d3c] font-semibold',
    formFieldLabel: 'text-[#1d2d3c] font-bold',
    footerActionLink: 'text-[#245c4c] font-bold',
    footerActionText: 'text-[#5f6e78]',
    dividerText: 'text-[#5f6e78]',
    identityPreviewEditButton: 'text-[#245c4c]',
    formFieldSuccessText: 'text-[#245c4c]',
    alertText: 'text-[#802b28]',
    logoBox: 'h-14',
    logoImage: 'h-14 w-14',
    formButtonPrimary: 'bg-[#245c4c] hover:bg-[#1d4a3d] text-white font-bold',
    formFieldInput: 'border border-[#ddd6c6] bg-[#f6f3ea] text-[#1d2d3c]',
    dividerLine: 'bg-[#ddd6c6]',
  },
};

function AuthScreen({ children }: { children: ReactNode }) {
  return <div className="auth-screen">{children}</div>;
}

export function ClerkShell({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: 'Welcome back to SIDEOUT', subtitle: 'Sign in to see your rating and profile' } },
        signUp: { start: { title: 'Join the club roster', subtitle: 'Create an account to manage your ELO visibility' } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <Switch>
        <Route path="/sign-in/*?"><AuthScreen><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></AuthScreen></Route>
        <Route path="/sign-up/*?"><AuthScreen><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></AuthScreen></Route>
        <Route>{children}</Route>
      </Switch>
    </ClerkProvider>
  );
}
