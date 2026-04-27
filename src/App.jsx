import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import GroupReport from './pages/GroupReport';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <nav className="navbar">
        <div className="navbar-inner">
          <NavLink to="/" className="navbar-brand">
            <span className="navbar-brand-icon">🌿</span>
            Agrofrutos
          </NavLink>
          <ul className="navbar-links">
            <li><NavLink to="/" end>Inicio</NavLink></li>
            <li><NavLink to="/reporte-grupo">Reporte por grupo</NavLink></li>
          </ul>
        </div>
      </nav>

      <div className="page">
        <Routes>
          <Route
            path="/"
            element={
              <div className="welcome-card">
                <h2>Sistema de Reportes de Cosecha</h2>
                <p>Selecciona una opción en el menú para generar un reporte.</p>
              </div>
            }
          />
          <Route path="/reporte-grupo" element={<GroupReport />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
