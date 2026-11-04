import { createContext,useState } from "react";
export const InterviewContext = createContext()
export const InterviewProvider = ({ children }) => {
    // loading: fetching a report or the list; generating: a report is being created (slow AI call)
    const [loading, setLoading] = useState(false)
    const [generating, setGenerating] = useState(false)
    const [report, setReport] = useState(null)
    const [reports, setReports] = useState([])
    // User-facing message for the last failed action (generate / load report / load list)
    const [error, setError] = useState(null)
    return (
        <InterviewContext.Provider value={{ loading, setLoading, generating, setGenerating, report, setReport, reports, setReports, error, setError }}>
            {children}
        </InterviewContext.Provider>
    )
}
