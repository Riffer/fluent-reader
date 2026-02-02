import * as React from "react"
import { Card } from "./card"
import CardInfo from "./info"
import Highlights from "./highlights"
import { ViewConfigs } from "../../schema-types"
import { SourceTextDirection } from "../../scripts/models/source"
import { useTranslation } from "../utils/use-translation"

const className = (props: Card.Props, isTranslating: boolean) => {
    let cn = ["card", "list-card"]
    if (props.item.hidden) cn.push("hidden")
    if (props.selected) cn.push("selected")
    if (props.viewConfigs & ViewConfigs.FadeRead && props.item.hasRead)
        cn.push("read")
    if (props.source.textDir === SourceTextDirection.RTL) cn.push("rtl")
    if (isTranslating) cn.push("translating")
    return cn.join(" ")
}

const ListCard: React.FunctionComponent<Card.Props> = props => {
    // On-demand translation - only translates when component renders
    const { title, snippet, isTranslating } = useTranslation(props.item, props.source)
    
    return (
        <div
            className={className(props, isTranslating)}
            {...Card.bindEventsToProps(props)}
            data-iid={props.item._id}
            data-is-focusable>
            {props.item.thumb && props.viewConfigs & ViewConfigs.ShowCover ? (
                <div className="head">
                    <img src={props.item.thumb} />
                </div>
            ) : null}
            <div className="data">
                <CardInfo source={props.source} item={props.item} />
                <h3 className="title">
                    <Highlights
                        text={title}
                        filter={props.filter}
                        title
                    />
                </h3>
                {Boolean(props.viewConfigs & ViewConfigs.ShowSnippet) && (
                    <p className="snippet">
                        <Highlights
                            text={snippet}
                            filter={props.filter}
                        />
                    </p>
                )}
            </div>
        </div>
    )
}

export default ListCard
