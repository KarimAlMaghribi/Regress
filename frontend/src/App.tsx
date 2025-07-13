import React from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import Upload from './pages/Upload';
import Prompts from './pages/Prompts';
import PromptAnalysis from './pages/PromptAnalysis';
import Pipeline from './pages/Pipeline';
import Dashboard from './pages/Dashboard';
import History from './pages/History';
import Analyses from './pages/Analyses';
import Result from './pages/Result';
import ColorModeProvider from './ColorModeContext';
import { PromptNotificationProvider } from './context/PromptNotifications';
import { AnimatePresence, motion } from 'framer-motion';

export default function App() {
  return (
    <ColorModeProvider>
      <PromptNotificationProvider>
        <Router>
          <Layout>
            <AnimatedRoutes />
          </Layout>
        </Router>
      </PromptNotificationProvider>
    </ColorModeProvider>
  );
}

function AnimatedRoutes() {
  const location = useLocation();
  React.useEffect(() => {
    console.log('Navigated to', location.pathname);
  }, [location.pathname]);
  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={<PageFade><Dashboard /></PageFade>} />
        <Route path="/upload" element={<PageFade><Upload /></PageFade>} />
        <Route path="/prompts" element={<PageFade><Prompts /></PageFade>} />
        <Route path="/pipeline" element={<PageFade><Pipeline /></PageFade>} />
        <Route path="/analysis" element={<PageFade><PromptAnalysis /></PageFade>} />
        <Route path="/analyses" element={<PageFade><Analyses /></PageFade>} />
        <Route path="/result/:id" element={<PageFade><Result /></PageFade>} />
        <Route path="/history" element={<PageFade><History /></PageFade>} />
        <Route path="*" element={<PageFade><Dashboard /></PageFade>} />
      </Routes>
    </AnimatePresence>
  );
}

function PageFade({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 32 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -32 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}
