import { createStoreWithSetters } from "./suss0";

// 1. Create the hook
const useLayoutStore = createStoreWithSetters({
  isSidebarOpen: false,
  themeColor: 'light'
});

// 2. Inside your React Component
function SidebarButton() {
  // Fully typed autocompletion out of the box!
  const isSidebarOpen = useLayoutStore((state) => state.isSidebarOpen);
  const setIsSidebarOpen = useLayoutStore((state) => state.setIsSidebarOpen);

  return <button onClick={() => setIsSidebarOpen(!isSidebarOpen)}>Toggle</button>;
}
